/** Provider/model identity already attached to captured usage and pricing facts.
 * This module only normalizes those facts; it does not resolve a provider
 * catalog or choose/update rates. */

export interface CapturedModelIdentityFacts {
  readonly modelId: string;
  readonly modelKey: string;
  readonly provider?: string;
}

/** Normalize a captured provider/model pair without changing its attribution.
 * A provider explicitly captured at invocation time wins over an id prefix. */
export function capturedModelIdentityFacts(
  modelId: string | undefined,
  capturedProvider?: string,
): CapturedModelIdentityFacts | undefined {
  if (!modelId) return undefined;
  const slash = modelId.lastIndexOf('/');
  const qualified = slash > 0 && slash < modelId.length - 1;
  const provider = capturedProvider || (qualified ? modelId.slice(0, slash) : undefined);
  return {
    modelId,
    modelKey: qualified ? modelId.slice(slash + 1) : modelId,
    ...(provider ? { provider } : {}),
  };
}

/** Return the bare model identity carried by a captured identifier. */
export function capturedModelKey(modelId: string): string {
  return capturedModelIdentityFacts(modelId)?.modelKey ?? modelId;
}

/** Return the provider explicitly captured or carried in a qualified identity. */
export function capturedModelProvider(modelId: string | undefined): string | undefined {
  return capturedModelIdentityFacts(modelId)?.provider;
}

/** Resolve a captured model identity against already supplied facts, preferring
 * an exact identity and falling back to its bare key for legacy fact maps. */
export function capturedModelFact<T>(
  modelId: string | undefined,
  facts: ReadonlyMap<string, T>,
): { readonly factKey: string; readonly facts: T } | undefined {
  if (!modelId) return undefined;
  if (facts.has(modelId)) return { factKey: modelId, facts: facts.get(modelId)! };
  const modelKey = capturedModelIdentityFacts(modelId)?.modelKey ?? modelId;
  if (modelKey !== modelId && facts.has(modelKey)) {
    return { factKey: modelKey, facts: facts.get(modelKey)! };
  }
  return undefined;
}
