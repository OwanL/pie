import * as path from 'node:path';

import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';

export function handleOpenFile(state: ArchState, cmd: Extract<Command, { kind: 'OpenFile' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'OpenFile',
        corrId: cmd.corrId,
        path: cmd.path,
      },
    ],
  };
}

export function handleOpenFileInEditor(state: ArchState, cmd: Extract<Command, { kind: 'OpenFileInEditor' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'OpenFileInEditor',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        filePath: cmd.filePath,
      },
    ],
  };
}

export function handleOpenFileDiff(state: ArchState, cmd: Extract<Command, { kind: 'OpenFileDiff' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'FileDiff',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        filePath: cmd.filePath,
        status: cmd.status,
      },
    ],
  };
}

export function handleRevertFile(state: ArchState, cmd: Extract<Command, { kind: 'RevertFile' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'FileRevert',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        filePath: cmd.filePath,
        ...(cmd.source !== undefined ? { source: cmd.source } : {}),
      },
    ],
  };
}

export function handleSetFileChangesExpanded(state: ArchState, cmd: Extract<Command, { kind: 'SetFileChangesExpanded' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.fileChanges.expandedBySession[cmd.sessionPath] = cmd.expanded;
    }),
    effects: [],
  };
}

export function handleSetFileRead(state: ArchState, cmd: Extract<Command, { kind: 'SetFileRead' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const list = draft.fileChanges.readFilePathsBySession[cmd.sessionPath] ?? [];
      const has = list.includes(cmd.filePath);
      if (cmd.read) {
        if (!has) draft.fileChanges.readFilePathsBySession[cmd.sessionPath] = [...list, cmd.filePath];
      } else if (has) {
        draft.fileChanges.readFilePathsBySession[cmd.sessionPath] = list.filter((p) => p !== cmd.filePath);
      }
    }),
    effects: [],
  };
}

/** `SetSystemPromptToggles` — no host state mutation. The backend owns the
 *  toggle set and re-emits `session.opened` with updated `disabled` flags on
 *  each `SystemPromptEntry`; that re-emit (routed through `SessionOpened`) is
 *  what updates `systemPromptsBySession`. This reducer only emits the RPC
 *  effect that pushes the new set to the backend. */
export function handleSetSystemPromptToggles(
  _state: ArchState,
  cmd: Extract<Command, { kind: 'SetSystemPromptToggles' }>,
): ReducerResult {
  return {
    state: _state,
    effects: [
      {
        kind: 'SetSystemPromptTogglesRpc',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        disabledEntries: [...cmd.disabledEntries],
      },
    ],
  };
}

export function handleAddFilesystemPaths(state: ArchState, cmd: Extract<Command, { kind: 'AddFilesystemPaths' }>): ReducerResult {
  // The reducer owns the composer-input append (pure): for each path,
  // create a `filesystemPathRef` input (ID from corrId, name from
  // basename), check for duplicates against existing inputs, skip
  // duplicates + empty paths, append to pendingComposerInputsBySession.
  // No Effect — there is no backend RPC for this op (purely a composer-
  // input mutation). The host-side entry (service.addFilesystemPaths)
  // resolved the target session (possibly via createNewSession()) +
  // cleaned the paths BEFORE dispatching this Command.
  const { sessionPath, paths, source } = cmd;
  const existing = state.composer.pendingComposerInputsBySession[sessionPath] ?? [];
  const nextInputs = [...existing];
  for (let i = 0; i < paths.length; i++) {
    const filesystemPath = paths[i].trim();
    if (!filesystemPath) continue;
    const duplicate = nextInputs.some(
      (inp) => inp.kind === 'filesystemPathRef' && inp.path === filesystemPath,
    );
    if (duplicate) continue;
    nextInputs.push({
      id: `${cmd.corrId}:input:${i}`,
      kind: 'filesystemPathRef',
      path: filesystemPath,
      name: path.basename(filesystemPath) || filesystemPath,
      source,
    });
  }
  // If no new inputs were added (all duplicates or empty), no state change.
  if (nextInputs.length === existing.length) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: {
          ...state.composer.pendingComposerInputsBySession,
          [sessionPath]: nextInputs,
        },
      },
    },
    effects: [],
  };
}
