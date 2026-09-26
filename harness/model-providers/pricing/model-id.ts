import { stripProviderPrefix } from '../catalog/model-id.js';

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
