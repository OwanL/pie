import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { stripReqIds } from '../../../shared/error-mapping.js';
import type {
  ComposerInput,
  ContextWindowUsage,
  ModelSettings,
  SessionSummary,
} from '../../../shared/protocol.js';

/**
 * setModel optimistic-apply / rollback helpers.
 *
 * The `SetModel` Command and `ModelSwitchConfirmResult` paths both apply the
 * switch optimistically via {@link applySetModelOptimistic}; `SetModelResult`
 * either clears the entry (success) or reverts via {@link revertSetModel}
 * (failure). All three are pure `(ArchState, ...) → ArchState` transitions —
 * the caller is responsible for emitting the matching `Effect`.
 *
 * Revert restores every field the optimistic apply flipped so the state matches
 * the pre-change state field-for-field (STATE_CONTRACT § Optimistic
 * Reconciliation: "optimistic UI writes must be reversible"). `undefined` vs
 * `null` in the snapshot distinguishes "key absent" (delete on revert) from
 * "key present with null" (set null on revert) for the two Record fields.
 */

/** Apply a model switch optimistically and record a rollback snapshot. */
export function applySetModelOptimistic(
  state: ArchState,
  corrId: string,
  sessionPath: string,
  modelSettings: ModelSettings,
  clearImages: boolean,
): ArchState {
  const previousModelSettings = state.settings.modelSettings;
  const previousSummary: SessionSummary | null =
    state.sessions.sessions.find((s) => s.path === sessionPath) ?? null;
  const previousContextUsage: ContextWindowUsage | null | undefined =
    sessionPath in state.settings.contextUsageBySession
      ? state.settings.contextUsageBySession[sessionPath]
      : undefined;
  // Snapshot unconditionally (like previousContextUsage): the optimistic apply
  // only clears inputs when clearImages is true, but revert must restore the
  // pre-apply state regardless of which path applied. Gating on clearImages
  // would leave previousPendingInputs === undefined on the no-modal path, and
  // revert would then DELETE present file-ref inputs that were never touched
  // (data loss). Restoring an unchanged field is a no-op.
  const previousPendingInputs: ComposerInput[] | undefined =
    sessionPath in state.composer.pendingComposerInputsBySession
      ? state.composer.pendingComposerInputsBySession[sessionPath]
      : undefined;

  return produce(state, (draft) => {
    // Global default model (what new sessions / the picker fall back to).
    draft.settings.modelSettings = modelSettings;

    // Per-session model badge (the current session's modelId/thinkingLevel).
    const idx = draft.sessions.sessions.findIndex((s) => s.path === sessionPath);
    if (idx >= 0) {
      draft.sessions.sessions[idx] = {
        ...draft.sessions.sessions[idx],
        modelId: modelSettings.defaultModel,
        thinkingLevel: modelSettings.defaultThinkingLevel,
      };
    }

    // Keep the last context-usage reading across the switch. The backend
    // re-emits a fresh ContextUsageChanged immediately after setModel (with the
    // new model's window and the same conversation's prompt footprint), so
    // nulling here would only flash a tokenizer-based transcript estimate before the
    // real reading lands. Holding the previous value keeps the indicator
    // stable across the switch.

    // Drop pending pasted image inputs when the new model can't accept them.
    // Only happens on the modal-confirmed path (clearImages === true).
    if (clearImages) {
      const existing = draft.composer.pendingComposerInputsBySession[sessionPath] ?? [];
      const remaining = existing.filter((input) => input.kind !== 'imageBlob');
      if (remaining.length === 0) {
        delete draft.composer.pendingComposerInputsBySession[sessionPath];
      } else {
        draft.composer.pendingComposerInputsBySession[sessionPath] = remaining;
      }
    }

    draft.pending.setModelByCorrId[corrId] = {
      sessionPath,
      modelSettings,
      snapshot: {
        previousModelSettings,
        previousSummary,
        previousContextUsage,
        previousPendingInputs,
      },
    };
  });
}

/** Drop the in-flight `SetModel` entry for `corrId` (RPC success or modal abort). */
export function dropSetModelPending(state: ArchState, corrId: string): ArchState {
  if (!(corrId in state.pending.setModelByCorrId)) {
    return state;
  }
  return produce(state, (draft) => {
    delete draft.pending.setModelByCorrId[corrId];
  });
}

/**
 * Revert the optimistic `SetModel` for `corrId` from its rollback snapshot,
 * surface a user-visible notice, and drop the entry. If no snapshot exists
 * (the modal was never confirmed before the result arrived — defensive), just
 * drop the entry and set the notice.
 */
export function revertSetModel(state: ArchState, corrId: string, error: string | undefined): ArchState {
  const pending = state.pending.setModelByCorrId[corrId];
  if (!pending) {
    return state;
  }
  // Strip any internal req-NN correlation id before the notice reaches the
  // user (Brief H criterion 1: no req-NN leaks). `settings.set` RPC timeouts
  // carry req-NN; the raw error is still logged host-side via the Log effect.
  const notice = `Failed to set model: ${stripReqIds(error ?? 'unknown error')}`;
  const raw = error ?? null;
  if (!pending.snapshot) {
    return produce(state, (draft) => {
      delete draft.pending.setModelByCorrId[corrId];
      draft.settings.notice = notice;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = raw;
    });
  }
  const snap = pending.snapshot;
  const sessionPath = pending.sessionPath;
  const previousSummary = snap.previousSummary;
  return produce(state, (draft) => {
    draft.settings.modelSettings = snap.previousModelSettings;

    if (previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === previousSummary.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = previousSummary;
      } else {
        draft.sessions.sessions.push(previousSummary);
      }
    }

    if (snap.previousContextUsage === undefined) {
      delete draft.settings.contextUsageBySession[sessionPath];
    } else {
      draft.settings.contextUsageBySession[sessionPath] = snap.previousContextUsage;
    }

    if (snap.previousPendingInputs === undefined) {
      delete draft.composer.pendingComposerInputsBySession[sessionPath];
    } else {
      draft.composer.pendingComposerInputsBySession[sessionPath] = snap.previousPendingInputs;
    }

    delete draft.pending.setModelByCorrId[corrId];
    draft.settings.notice = notice;
    draft.settings.noticeKind = null;
    draft.settings.noticeRaw = raw;
  });
}

export function handleAvailableModelsChanged(
  state: ArchState,
  event: Extract<Event, { kind: 'AvailableModelsChanged' }>,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        availableModelsBySession: {
          ...state.settings.availableModelsBySession,
          [event.sessionPath]: event.models,
        },
      },
    },
    effects: [],
  };
}

/** Read-only sync of the global `modelSettings` from the backend (hydrate).
 *  Updates only `state.settings.modelSettings` — no per-session badge change,
 *  no `SetModelRpc`, no persistence. See `ModelSettingsHydratedEvent`. */
export function handleModelSettingsHydrated(
  state: ArchState,
  event: Extract<Event, { kind: 'ModelSettingsHydrated' }>,
): ReducerResult {
  const current = state.settings.modelSettings;
  if (current
    && current.defaultModel === event.modelSettings.defaultModel
    && current.defaultProvider === event.modelSettings.defaultProvider
    && current.defaultThinkingLevel === event.modelSettings.defaultThinkingLevel) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        modelSettings: event.modelSettings,
      },
    },
    effects: [],
  };
}