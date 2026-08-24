import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
import { modelSupportsInputKind } from '../model-capability.js';
import {
  applySetModelOptimistic,
  finishDeferredSetModelReplay,
  queueDeferredSetModel,
} from './set-model-handlers.js';

function isNoOpModelSelection(state: ArchState, sessionPath: string, modelSettings: { defaultModel?: string; defaultProvider?: string; defaultThinkingLevel?: string }): boolean {
  const currentSettings = state.settings.modelSettings;
  const currentSummary = state.sessions.sessions.find((session) => session.path === sessionPath);
  if (!currentSettings) {
    return false;
  }

  const settingsMatch =
    currentSettings.defaultModel === modelSettings.defaultModel
    && currentSettings.defaultProvider === modelSettings.defaultProvider
    && currentSettings.defaultThinkingLevel === modelSettings.defaultThinkingLevel;
  if (!settingsMatch) {
    return false;
  }

  // If the session summary has not been hydrated with its per-session model
  // badge yet (or the badge is missing), there is nothing to correct — treat
  // it as in-sync so a refresh-state event doesn't force a spurious
  // settings.set.
  if (!currentSummary || currentSummary.modelId === undefined) {
    return true;
  }

  return currentSummary.modelId === modelSettings.defaultModel
    && currentSummary.provider === modelSettings.defaultProvider
    && currentSummary.thinkingLevel === modelSettings.defaultThinkingLevel;
}

export function handleHydrateModel(state: ArchState, cmd: Extract<Command, { kind: 'HydrateModel' }>): ReducerResult {
  // Pending paths are host-only placeholders, including their normalized
  // pseudo-path variants. They have no durable backend file to hydrate.
  if (isPendingTabPath(cmd.sessionPath)
    || !state.sessions.openTabPaths.includes(cmd.sessionPath)) {
    return { state, effects: [] };
  }

  // Capture the hydration revision and the model-write fence before either
  // asynchronous branch starts. The service carries both values onto each
  // result so a late response cannot undo an optimistic SetModel.
  const hydrationRevision = state.settings.modelHydrationRevision + 1;
  const nextState = produce(state, (draft) => {
    draft.settings.modelHydrationRevision = hydrationRevision;
    draft.settings.modelHydrationRevisionBySession[cmd.sessionPath] = hydrationRevision;
    // A refresh does not make an already-renderable catalog unusable. Keep its
    // authoritative/provisional status and only expose loading for a session
    // that genuinely has no choices yet.
    if ((draft.settings.availableModelsBySession[cmd.sessionPath]?.length ?? 0) === 0
      && draft.settings.availableModelsStatusBySession[cmd.sessionPath] !== 'authoritative') {
      draft.settings.availableModelsStatusBySession[cmd.sessionPath] = 'loading';
    }
  });
  return {
    state: nextState,
    effects: [{
      kind: 'HydrateModel',
      corrId: cmd.corrId,
      sessionPath: cmd.sessionPath,
      hydrationRevision,
      modelWriteFence: state.settings.modelWriteFence,
    }],
  };
}

export function handleSetModel(state: ArchState, cmd: Extract<Command, { kind: 'SetModel' }>): ReducerResult {
  const { sessionPath, modelSettings } = cmd;

  // A fresh picker click supersedes any older confirmation still open for the
  // same session. Otherwise confirming that stale modal could overwrite the
  // later choice after it had already entered the deferred queue.
  const workingState = cmd.deferredReplay
    ? state
    : produce(state, (draft) => {
        for (const [corrId, pending] of Object.entries(draft.pending.setModelByCorrId)) {
          if (corrId !== cmd.corrId && pending.sessionPath === sessionPath && pending.snapshot === null) {
            delete draft.pending.setModelByCorrId[corrId];
          }
        }
      });

  // Relocated guard (was service.requireOpenSessionPath): the reducer owns
  // the precondition so an invalid request can't leave an optimistic
  // modelSettings change un-reverted.
  const targetIsPending = isPendingTabPath(sessionPath);
  const guardNotice = !sessionPath
    ? 'Cannot set model: missing session reference.'
    : !workingState.sessions.openTabPaths.includes(sessionPath)
      ? 'Cannot set model: the selected session is no longer open.'
      : null;
  if (guardNotice) {
    const guarded = {
      ...workingState,
      settings: {
        ...workingState.settings,
        notice: guardNotice,
        noticeKind: null,
        noticeRaw: null,
        noticeSessionPath: sessionPath || null,
      },
    };
    if (cmd.deferredReplay) {
      return finishDeferredSetModelReplay(guarded, cmd.corrId);
    }
    return { state: guarded, effects: [] };
  }

  if (!cmd.deferredReplay && isNoOpModelSelection(workingState, sessionPath, modelSettings)) {
    return { state: workingState, effects: [] };
  }

  // Decide whether the switch would drop pending image inputs. This is a
  // pure read of ArchState (pending inputs + the requested model's input
  // capabilities), so the reducer owns the decision and gates the
  // optimistic apply on the user's modal confirmation.
  const pendingInputs = workingState.composer.pendingComposerInputsBySession[sessionPath] ?? [];
  const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
  const requestedModelSupportsImages = modelSupportsInputKind(
    sessionPath,
    modelSettings.defaultModel,
    'image',
    () => workingState,
  );
  const shouldClearPendingImages = hasPendingImageInputs && requestedModelSupportsImages === false;

  if (shouldClearPendingImages && cmd.clearImagesConfirmed !== true) {
    const next = produce(workingState, (draft) => {
      draft.pending.setModelByCorrId[cmd.corrId] = {
        sessionPath,
        modelSettings,
        snapshot: null,
      };
    });
    return {
      state: next,
      effects: [{
        kind: 'ShowModelSwitchConfirm',
        corrId: cmd.corrId,
        sessionPath,
        modelSettings,
        message:
          'Switching to this model will remove pending pasted images because it does not support image inputs.',
        confirmChoice: 'Switch Model',
        ...(cmd.source !== undefined ? { source: cmd.source } : {}),
      }],
    };
  }

  // Pending placeholders and a temporarily unavailable backend are not valid
  // RPC targets. Keep the picker responsive, coalesce the latest choice, and
  // replay it against the durable path through the ordinary rollback-capable
  // SetModel lifecycle when the target becomes writable.
  const anotherModelWriteIsInFlight = Object.entries(workingState.pending.setModelByCorrId)
    .some(([corrId, pending]) => corrId !== cmd.corrId && pending.snapshot !== null);
  if (targetIsPending
    || !workingState.settings.backendReady
    || anotherModelWriteIsInFlight
    || (workingState.pending.deferredSetModelInFlightCorrId !== null
      && workingState.pending.deferredSetModelInFlightCorrId !== cmd.corrId)) {
    let queued = queueDeferredSetModel(
      workingState,
      cmd.corrId,
      sessionPath,
      modelSettings,
      cmd.clearImagesConfirmed === true,
    );
    if (cmd.deferredReplay) {
      queued = produce(queued, (draft) => {
        draft.pending.deferredSetModelInFlightCorrId = null;
        draft.pending.deferredSetModelInFlightSessionPath = null;
      });
    }
    return { state: queued, effects: [] };
  }

  // Deferred replay bypasses the no-op shortcut above because the restored
  // badge/global baseline is only a rollback snapshot; the per-session choice
  // has not yet been persisted.
  const clearImages = cmd.clearImagesConfirmed === true;
  return {
    state: applySetModelOptimistic(workingState, cmd.corrId, sessionPath, modelSettings, clearImages),
    effects: [{ kind: 'SetModelRpc', corrId: cmd.corrId, sessionPath, modelSettings }],
  };
}
