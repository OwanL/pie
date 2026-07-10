/**
 * Provider toggle parsing.
 *
 * Mirrors the provider-enablement JSON from PIE_PROVIDER_TOGGLES_JSON into
 * disabled-provider sets and model-id allowlists.
 */

import { parseJsonOrThrow } from "../../../shared/error-message.js";

export const PROVIDER_TOGGLES_ENV = "PIE_PROVIDER_TOGGLES_JSON";

export interface ModelProviderRef {
  id: string;
  provider: string;
}

export function parseProviderToggles(
  raw: string | undefined,
): Record<string, boolean> {
  if (!raw) return {};

  try {
    const parsed = parseJsonOrThrow<unknown>(raw, "provider toggles");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const toggles: Record<string, boolean> = {};
    for (const [provider, enabled] of Object.entries(parsed)) {
      if (typeof enabled === "boolean") toggles[provider] = enabled;
    }
    return toggles;
  } catch {
    return {};
  }
}

export function getDisabledProviders(
  providerToggles: Record<string, boolean>,
): Set<string> {
  return new Set(
    Object.entries(providerToggles)
      .filter(([, enabled]) => enabled === false)
      .map(([provider]) => provider),
  );
}

export function getAllowedModelIdsForProviders(
  models: ModelProviderRef[],
  disabledProviders: Set<string>,
): Set<string> | undefined {
  if (disabledProviders.size === 0) return undefined;

  return new Set(
    models
      .filter((model) => !disabledProviders.has(model.provider))
      .map((model) => model.id),
  );
}
