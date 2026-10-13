import catalog from '../../../models.json';
import type { ShippedProviderDefinition, ProviderModelMetadata } from '../catalog/provider-model-resolution';

/** Bundled checked-in generated catalog authority. Never reads agentDir, user
 * registries or historical pricing catalogs. models.yaml -> sync-models owns it. */
export function approvedShippedRuntimeCatalog(): Readonly<Record<string, ShippedProviderDefinition>> {
  const result: Record<string, ShippedProviderDefinition> = Object.create(null);
  for (const [provider, definition] of Object.entries(catalog.providers)) {
    const models: Record<string, ProviderModelMetadata> = Object.create(null);
    for (const model of definition.models) {
      const row = model as unknown as Record<string, unknown>;
      models[model.id] = { name: model.name, input: ['text'], reasoning: false,
        ...(row.input ? { input: row.input as ('text' | 'image')[] } : {}),
        ...(typeof row.reasoning === 'boolean' ? { reasoning: row.reasoning } : {}),
        contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        pricing: model.cost };
    }
    const row = definition as unknown as Record<string, unknown>;
    result[provider] = { api: row.api as ShippedProviderDefinition['api'],
      baseUrl: row.baseUrl as string, models };
  }
  return result;
}
