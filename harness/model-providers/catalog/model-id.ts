/** Provider-qualified model identity helpers used by the model catalog. */

/** Strip the provider prefix from a qualified id (`provider/id` → `id`).
 *  Ids without a slash (or with a leading/trailing slash) are unchanged. */
export function stripProviderPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash > 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : modelId;
}

/** Runtime provider namespace of a qualified id (`provider/id` → `provider`),
 *  or `undefined` for bare ids. */
export function providerPrefixOf(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const slash = modelId.lastIndexOf('/');
  return slash > 0 && slash < modelId.length - 1 ? modelId.slice(0, slash) : undefined;
}

/** Qualify a bare model id without duplicating an existing provider prefix. */
export function qualifyModelId(
  modelId: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!modelId || !provider || modelId.startsWith(`${provider}/`)) return modelId;
  return `${provider}/${modelId}`;
}
