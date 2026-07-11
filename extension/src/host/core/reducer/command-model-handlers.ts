import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
import { modelSupportsInputKind } from '../model-capability.js';
import { applySetModelOptimistic } from './set-model-handlers.js';

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
    && currentSummary.thinkingLevel === modelSettings.defaultThinkingLevel;
}

export function handleHydrateModel(state: ArchState, cmd: Extract<Command, { kind: 'HydrateModel' }>): ReducerResult {
  // No state change: emit a fire-and-forget effect. The runner calls the
  // service; the service's dispatched ModelSettingsHydrated/AvailableModelsChanged
  // events apply the results, so no *Result event is produced here.
  return {
    state,
    effects: [{ kind: 'HydrateModel', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
  };
}

export function handleSetModel(state: ArchState, cmd: Extract<Command, { kind: 'SetModel' }>): ReducerResult {
  const { sessionPath, modelSettings } = cmd;

  // Relocated guard (was service.requireOpenSessionPath): the reducer owns
  // the precondition so an invalid request can't leave an optimistic
  // modelSettings change un-reverted. The old path applied optimistically in
  // the reducer, then the service guard bailed without reverting — so a
  // setModel aimed at a closed/pending session silently flipped the global
  // default and never rolled back.
  const guardNotice = !sessionPath
    ? 'Cannot set model: missing session reference.'
    : isPendingTabPath(sessionPath)
      ? 'Cannot set model: the session is still opening.'
      : !state.sessions.openTabPaths.includes(sessionPath)
        ? 'Cannot set model: the selected session is no longer open.'
        : null;
  if (guardNotice) {
    return {
      state: { ...state, settings: { ...state.settings, notice: guardNotice } },
      effects: [],
    };
  }

  if (isNoOpModelSelection(state, sessionPath, modelSettings)) {
    return {
      state,
      effects: [],
    };
  }

  // Decide whether the switch would drop pending image inputs. This is a
  // pure read of ArchState (pending inputs + the requested model's input
  // capabilities), so the reducer owns the decision and gates the
  // optimistic apply on the user's modal confirmation. The user-facing
  // copy lives in the emitted effect, not in a service call.
  const pendingInputs = state.composer.pendingComposerInputsBySession[sessionPath] ?? [];
  const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
  const requestedModelSupportsImages = modelSupportsInputKind(
    sessionPath,
    modelSettings.defaultModel,
    'image',
    () => state,
  );
  const shouldClearPendingImages = hasPendingImageInputs && requestedModelSupportsImages === false;

  if (shouldClearPendingImages) {
    // Stash the intent and ask the user via a modal Effect. No state changes
    // until confirmation, so an abort leaves everything untouched — fixes
    // the old bug where the optimistic apply survived a "Cancel".
    const next = produce(state, (draft) => {
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
      }],
    };
  }

  // No modal needed: apply optimistically (no image clear here — either
  // there are no pending images to lose, or the new model still supports
  // them) and emit the backend write.
  return {
    state: applySetModelOptimistic(state, cmd.corrId, sessionPath, modelSettings, false),
    effects: [{ kind: 'SetModelRpc', corrId: cmd.corrId, sessionPath, modelSettings }],
  };
}
