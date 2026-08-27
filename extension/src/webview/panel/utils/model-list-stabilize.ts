import type { ModelInfo } from '../../../shared/protocol';

/**
 * Reference-stabilization helper for the host-delivered `availableModels`
 * array (`ViewState.availableModels`).
 *
 * The host re-serialises the whole `ViewState` on every `state` message
 * (≈7/sec while streaming, debounced to 150ms). `postMessage`'s structured
 * clone gives every array element a fresh reference even when its content is
 * byte-identical, which defeats the `memo()` / `useMemo` barriers downstream
 * that key on the `availableModels` ref — notably the model-state and
 * pricing-by-model-id memos in `useComposerIndicators`, and the `Composer` /
 * `BottomSection` / `VirtualRow` memo boundaries above the indicator layer.
 *
 * Unlike the flat config objects stabilised in `view-state-stabilize.ts`,
 * `ModelInfo` has nested object fields (`inputKinds[]`, `subagent?` with its
 * own nested `pricing?`), so {@link shallowConfigEqual} can't stabilise it (its
 * `primitiveCollectionsEqual` compares elements by `===`, which fails for the
 * freshly-cloned nested objects → reports "not equal" → no-op). Instead we
 * build a structural signature per model and compare signatures, mirroring the
 * `indicator-signature.ts` pattern. The signature covers every field that
 * downstream reads (id/name/provider/reasoning/inputKinds/contextWindow/
 * maxTokens + explicit thinking levels + the full `subagent` shape including
 * `pricing`), so a
 * byte-identical snapshot reuses the cached reference and a genuinely
 * different model list (new model, toggled eligibility, updated pricing) is
 * adopted. The caller owns the cached reference (module-level `let` in
 * `use-host-sync`); this helper is pure and stateless.
 *
 * Fails SAFE: any field the signature omits would also be omitted from the
 * comparison, but every observable `ModelInfo` field is included, so two
 * structurally-equal arrays always reuse the cached ref and two
 * structurally-different arrays never do.
 */

/**
 * Build a structural signature for a single {@link ModelInfo}. Covers every
 * field downstream code reads. `inputKinds` is joined in order (the array is
 * short and order is semantically meaningful for capability checks). The
 * optional `thinkingLevels` list and `subagent` block are serialised
 * field-by-field including its nested `pricing` quadruple so that any
 * reasoning-capability, pricing/eligibility/cost update is detected.
 */
function modelSignature(m: ModelInfo): string {
  const sub = m.subagent;
  const pricing = sub?.pricing;
  const subSig = sub
    ? `${sub.eligible ? 1 : 0}|${sub.disabledReason ?? ''}|${
        pricing ? `${pricing.input}:${pricing.output}:${pricing.cacheRead}:${pricing.cacheWrite}` : ''
      }`
    : '';
  return [
    m.id,
    m.name,
    m.provider,
    m.reasoning ? 1 : 0,
    m.inputKinds.join(','),
    m.thinkingLevels?.join(',') ?? '',
    m.contextWindow ?? '',
    m.maxTokens ?? '',
    subSig,
  ].join('|');
}

/**
 * Structural equality for two `ModelInfo[]` by per-element signature. Same
 * length + identical signatures ⇒ equal. O(n) but `n` is small (the picker
 * list, tens at most) and changes rarely, so this is cheap relative to the
 * downstream `useMemo` work it gates.
 */
function modelListsEqual(a: readonly ModelInfo[], b: readonly ModelInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (modelSignature(a[i]) !== modelSignature(b[i])) return false;
  }
  return true;
}

/**
 * Reuse `stable` when its content structurally equals `candidate` (keeping a
 * stable reference across host state posts that didn't actually change the
 * model list), otherwise adopt `candidate`. Pure and stateless; the caller
 * owns the cached reference (e.g. a module-level `let`).
 */
export function pickStableModelList(stable: ModelInfo[] | null, candidate: ModelInfo[]): ModelInfo[] {
  if (stable && modelListsEqual(stable, candidate)) {
    return stable;
  }
  return candidate;
}
