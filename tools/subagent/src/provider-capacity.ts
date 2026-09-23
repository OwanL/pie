import {
  readProviderCapacitySnapshot,
  type ProviderCapacitySnapshot,
} from "../../../shared/provider-capacity-bridge.js";
import type { ModelProviderRef } from "./provider-toggles.js";
import { qualifiedModelSpec } from "./bucket-config.js";

export const SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV =
  "PIE_SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS";
const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = "PIE_SUBAGENT_ALWAYS_PARENT_MODEL";

function readBooleanEnv(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

export function readRouteAroundSaturatedProviders(): boolean {
  return readBooleanEnv(SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV);
}

export function readAlwaysParentModelFromEnv(): boolean {
  return readBooleanEnv(SUBAGENT_ALWAYS_PARENT_MODEL_ENV);
}

/**
 * Build the soft capacity allowlist used after normal bucket/provider
 * filtering. Qualified specs are evaluated against their exact provider;
 * legacy bare ids stay eligible when any enabled provider has an immediate
 * slot or no capacity entry (unknown state fails open).
 */
export function getCapacityAvailableModelIds(
  models: ModelProviderRef[],
  disabledProviders: Set<string>,
  snapshot: ProviderCapacitySnapshot | undefined = readProviderCapacitySnapshot(),
): Set<string> | undefined {
  if (!snapshot) return undefined;

  const enabledModels = models.filter((model) => !disabledProviders.has(model.provider));
  if (!enabledModels.some((model) => snapshot[model.provider] !== undefined)) {
    return undefined;
  }

  const providersByModel = new Map<string, Set<string>>();
  for (const model of enabledModels) {
    const providers = providersByModel.get(model.id) ?? new Set<string>();
    providers.add(model.provider);
    providersByModel.set(model.id, providers);
  }

  const available = new Set<string>();
  for (const model of enabledModels) {
    const state = snapshot[model.provider];
    if (state === undefined || state.immediatelyClaimable) {
      available.add(qualifiedModelSpec(model.provider, model.id));
    }
  }
  for (const [modelId, providers] of providersByModel) {
    if ([...providers].some((provider) => {
      const state = snapshot[provider];
      return state === undefined || state.immediatelyClaimable;
    })) available.add(modelId);
  }
  return available;
}
