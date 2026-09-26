import type { ArchState } from './arch-state.js';

/**
 * Thunk returning the current ArchState. Pure-spine call sites (the reducer)
 * already hold the state and pass `() => state`; impure callers (the composer
 * attach path) pass a live `getArchState` thunk.
 */
export type GetArchState = () => ArchState;

/**
 * Whether the model that would be used for `sessionPath` — the explicitly
 * requested one, else the session's current model, else the global default —
 * accepts `inputKind` (`'text' | 'image'`).
 *
 * Pure: reads only ArchState (per-session available models, the session's
 * current modelId, the global default). Lives in the pure spine so the reducer
 * can decide whether a model switch would drop pending image inputs without
 * pulling `vscode` (imported by `composer.ts`) into its module graph.
 *
 * Fallback semantics match the composer attach path: if no model is known,
 * text is always supported and image is not; if the model metadata is absent
 * from the available-models tables, assume text-only.
 */
export function modelSupportsInputKind(
  sessionPath: string,
  requestedModelId: string | undefined,
  inputKind: 'text' | 'image',
  getArchState: GetArchState = () => { throw new Error('getArchState is required to resolve model input-kind support, but no thunk was provided'); },
): boolean {
  const archState = getArchState();
  const modelId = requestedModelId
    ?? archState.sessions.sessions.find((s) => s.path === sessionPath)?.modelId
    ?? archState.settings.modelSettings?.defaultModel;
  if (!modelId) {
    return inputKind === 'text';
  }

  const directModels = archState.settings.availableModelsBySession[sessionPath] ?? [];
  const fallbackModels = Object.values(archState.settings.availableModelsBySession)
    .flatMap((models) => models);
  const model = [...directModels, ...fallbackModels].find((candidate) => candidate.id === modelId);
  if (!model) {
    return inputKind === 'text';
  }

  return model.inputKinds.includes(inputKind);
}