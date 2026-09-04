import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { stripReqIds } from '../../../shared/error-mapping.js';
import { modelSettingsMatchForHydration } from '../../../shared/protocol.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
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
    // Advance before applying the optimistic write. Hydration results capture
    // this value at request start and older results are rejected below.
    draft.settings.modelWriteFence += 1;

    // Global default model (what new sessions / the picker fall back to).
    draft.settings.modelSettings = modelSettings;

    // Per-session model badge (the current session's provider/model/thinking level).
    const idx = draft.sessions.sessions.findIndex((s) => s.path === sessionPath);
    if (idx >= 0) {
      draft.sessions.sessions[idx] = {
        ...draft.sessions.sessions[idx],
        modelId: modelSettings.defaultModel,
        ...(modelSettings.defaultProvider !== undefined && { provider: modelSettings.defaultProvider }),
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

/** Retain the latest choice while the target is temporarily unwritable. The
 * active session badge changes immediately so the controlled picker reflects
 * the click, but the global persisted default is left untouched until replay.
 * Repeated choices coalesce while preserving the original baseline for a
 * truthful rollback once the normal SetModel lifecycle runs. */
export function queueDeferredSetModel(
  state: ArchState,
  corrId: string,
  sessionPath: string,
  modelSettings: ModelSettings,
  clearImages: boolean,
): ArchState {
  const existing = state.pending.deferredSetModelBySession[sessionPath];
  const currentSummary = state.sessions.sessions.find((summary) => summary.path === sessionPath);
  return produce(state, (draft) => {
    const index = draft.sessions.sessions.findIndex((summary) => summary.path === sessionPath);
    if (index >= 0) {
      const summary = draft.sessions.sessions[index]!;
      summary.modelId = modelSettings.defaultModel;
      if (modelSettings.defaultProvider !== undefined) summary.provider = modelSettings.defaultProvider;
      summary.thinkingLevel = modelSettings.defaultThinkingLevel;
    }
    const sequence = draft.pending.deferredSetModelSequence + 1;
    draft.pending.deferredSetModelSequence = sequence;
    draft.pending.deferredSetModelBySession[sessionPath] = {
      corrId,
      sessionPath,
      modelSettings,
      clearImages,
      sequence,
      previousModelId: existing ? existing.previousModelId : currentSummary?.modelId,
      previousProvider: existing ? existing.previousProvider : currentSummary?.provider,
      previousThinkingLevel: existing ? existing.previousThinkingLevel : currentSummary?.thinkingLevel,
    };
    // A confirmed image-removal modal used setModelByCorrId only to retain its
    // intent. Once deferred, this dedicated queue owns the lifecycle.
    delete draft.pending.setModelByCorrId[corrId];
  });
}

export function sessionHasDeferredModelWrite(state: ArchState, sessionPath: string): boolean {
  return state.pending.deferredSetModelInFlightSessionPath === sessionPath
    || state.pending.deferredSetModelBySession[sessionPath] !== undefined;
}

/** Start exactly one deferred write, in original click order. Head-of-line
 * blocking on a pending path is intentional: settings.set also persists the
 * global default, so replaying a later click first would let an older pending
 * session overwrite that default when it eventually resolves. */
export function startNextDeferredSetModel(state: ArchState): ReducerResult {
  if (!state.settings.backendReady || state.pending.deferredSetModelInFlightCorrId) {
    return { state, effects: [] };
  }
  const next = Object.values(state.pending.deferredSetModelBySession)
    .sort((a, b) => a.sequence - b.sequence)[0];
  if (!next || isPendingTabPath(next.sessionPath)) {
    return { state, effects: [] };
  }

  const nextState = produce(state, (draft) => {
    const summary = draft.sessions.sessions.find((item) => item.path === next.sessionPath);
    if (summary) {
      if (next.previousModelId === undefined) delete summary.modelId;
      else summary.modelId = next.previousModelId;
      if (next.previousProvider === undefined) delete summary.provider;
      else summary.provider = next.previousProvider;
      if (next.previousThinkingLevel === undefined) delete summary.thinkingLevel;
      else summary.thinkingLevel = next.previousThinkingLevel;
    }
    delete draft.pending.deferredSetModelBySession[next.sessionPath];
    draft.pending.deferredSetModelInFlightCorrId = next.corrId;
    draft.pending.deferredSetModelInFlightSessionPath = next.sessionPath;
  });
  const effect: Effect = {
    kind: 'DrainDeferredSetModelQueue',
    corrId: `drain-model:${next.corrId}`,
    entries: [next],
  };
  return { state: nextState, effects: [effect] };
}

/** Mark one replay complete and start the next ordered choice, if writable. */
export function finishDeferredSetModelReplay(state: ArchState, corrId: string): ReducerResult {
  const inFlightCorrId = state.pending.deferredSetModelInFlightCorrId;
  if (inFlightCorrId !== null && inFlightCorrId !== corrId) {
    return { state, effects: [] };
  }
  const cleared = inFlightCorrId === corrId
    ? produce(state, (draft) => {
        draft.pending.deferredSetModelInFlightCorrId = null;
        draft.pending.deferredSetModelInFlightSessionPath = null;
      })
    : state;
  // A normal (non-deferred) SetModel may have caused later clicks to enter the
  // same ordered queue. Its result has no deferred marker, but still releases
  // the head once its own optimistic snapshot has reconciled.
  return startNextDeferredSetModel(cleared);
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
  // user (no req-NN leaks to the renderer boundary). `settings.set` RPC timeouts
  // carry req-NN; the raw error is still logged host-side via the Log effect.
  const notice = `Failed to set model: ${stripReqIds(error ?? 'unknown error')}`;
  const raw = error ? stripReqIds(error) : null;
  if (!pending.snapshot) {
    return produce(state, (draft) => {
      delete draft.pending.setModelByCorrId[corrId];
      draft.settings.notice = notice;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = raw;
      draft.settings.noticeSessionPath = pending.sessionPath;
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
    draft.settings.noticeSessionPath = sessionPath;
  });
}

function isStaleHydrationResult(
  state: ArchState,
  event: {
    sessionPath: string;
    backendGeneration: number;
    hydrationRevision: number;
    modelWriteFence: number;
  },
  scope: 'global-settings' | 'session-catalog',
): boolean {
  const settings = state.settings;
  // A result from an exited backend must never repopulate the new generation.
  if (event.backendGeneration < settings.modelBackendGeneration) {
    return true;
  }
  // Settings are global, so a later hydration started for another session also
  // supersedes this result. Catalog revisions remain scoped to their path.
  const currentRevision = scope === 'global-settings'
    ? settings.modelHydrationRevision
    : settings.modelHydrationRevisionBySession[event.sessionPath] ?? 0;
  if (event.hydrationRevision < currentRevision) {
    return true;
  }
  // SetModel advances this fence before its optimistic state is applied. Only
  // an explicit hydration started after that write may replace settings or
  // capability metadata.
  return event.modelWriteFence < settings.modelWriteFence;
}

function nextModelHydrationSettings(
  state: ArchState,
  event: {
    backendGeneration: number;
    hydrationRevision: number;
    sessionPath: string;
  },
): ArchState['settings'] {
  const settings = state.settings;
  return {
    ...settings,
    modelBackendGeneration: Math.max(settings.modelBackendGeneration, event.backendGeneration),
    modelHydrationRevisionBySession: {
      ...settings.modelHydrationRevisionBySession,
      [event.sessionPath]: Math.max(
        settings.modelHydrationRevisionBySession[event.sessionPath] ?? 0,
        event.hydrationRevision,
      ),
    },
  };
}

export function handleAvailableModelsChanged(
  state: ArchState,
  event: Extract<Event, { kind: 'AvailableModelsChanged' }>,
): ReducerResult {
  if (!state.sessions.openTabPaths.includes(event.sessionPath)
    || isStaleHydrationResult(state, event, 'session-catalog')) {
    return { state, effects: [] };
  }
  const settings = nextModelHydrationSettings(state, event);
  return {
    state: {
      ...state,
      settings: {
        ...settings,
        availableModelsBySession: {
          ...settings.availableModelsBySession,
          [event.sessionPath]: event.models,
        },
        // A successful empty catalog is still authoritative. Hydration failures
        // do not dispatch this event, so a provisional catalog is never cleared
        // merely because one branch failed.
        availableModelsStatusBySession: {
          ...settings.availableModelsStatusBySession,
          [event.sessionPath]: 'authoritative',
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
  if (!state.sessions.openTabPaths.includes(event.sessionPath)
    || isStaleHydrationResult(state, event, 'global-settings')) {
    return { state, effects: [] };
  }
  const current = state.settings.modelSettings;
  const hydratedSettings = nextModelHydrationSettings(state, event);
  if (modelSettingsMatchForHydration(current, event.modelSettings)) {
    return {
      state: hydratedSettings === state.settings ? state : { ...state, settings: hydratedSettings },
      effects: [],
    };
  }
  return {
    state: {
      ...state,
      settings: {
        ...hydratedSettings,
        modelSettings: event.modelSettings,
      },
    },
    effects: [],
  };
}
