/**
 * Provider-qualified model-id normalization shared by host and webview cost
 * accounting.
 *
 * The runtime serves subagent/child sessions with provider-qualified model ids
 * (`ollama/glm-5.2:cloud`, `openai-codex/gpt-5.6-terra`), while pricing
 * catalogs and the webview model registry key by the bare id
 * (`glm-5.2:cloud`). Every pricing lookup must therefore tolerate the prefix or
 * the usage is misattributed to an 'unknown' provider/model bucket (the model
 * id fails the catalog lookup, and — because provider resolution depends on the
 * catalog — the recorded provider is lost too).
 *
 * Mirror of the analytics pipeline's `resolveModelFamily`/`resolveModelProvider`
 * suffix logic (`analysis/scripts/model-family.ts`).
 */

/** Strip the provider prefix from a qualified id (`provider/id` → `id`).
 *  Ids without a slash (or with a leading/trailing slash) are unchanged. */
export function stripProviderPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash > 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : modelId;
}

/** Qualify a bare model id without duplicating an existing provider prefix. */
export function qualifyModelId(
  modelId: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!modelId || !provider || modelId.startsWith(`${provider}/`)) return modelId;
  return `${provider}/${modelId}`;
}

/** Resolve the pricing-catalog key for a possibly prefixed id: try the full id
 *  first, then the suffix after the last `/`. Returns `null` when neither is a
 *  known key. `has` is the catalog's membership probe (a `Map#has`). */
export function resolvePricingCatalogKey(
  modelId: string | undefined,
  has: (key: string) => boolean,
): string | null {
  if (!modelId) return null;
  if (has(modelId)) return modelId;
  const bare = stripProviderPrefix(modelId);
  return bare !== modelId && has(bare) ? bare : null;
}
