import type { Model } from "@mariozechner/pi-ai";
import type { ProviderCapacitySnapshot } from "../../shared/provider-capacity-bridge.js";
import {
	modelInputSatisfiesRequirement,
	requirementIsActive,
} from "./src/selection.js";
import type { ModelRequirements } from "./types.js";
import { parseModelSpec } from "./src/bucket-config.js";

export interface ModelRegistryLike {
	getAvailable(): Model<any>[];
	getAll(): Model<any>[];
	find(provider: string, id: string): Model<any> | undefined;
}

export interface ResolvedExecutionModel {
	resolvedModel: Model<any> | undefined;
	actualModelId: string | undefined;
	diagnostic?: string;
}

/**
 * Resolve the requested subagent model against the registry.
 *
 * - A canonical `provider/id` request resolves only through the exact
 *   `registry.find(provider, id)` entry.
 * - A legacy bare id preserves caller-provider preference and registry fallback.
 * - When the requested model cannot be found (or only exists on disabled
 *   providers), fall back to the caller model when possible and emit a diagnostic.
 * - When no requested model is present, inherit the caller model.
 *
 * When `modelRequirements` is active, the duplicate-id walk is provider-qualified
 * by runtime `input` capability: only providers whose declaration satisfies the
 * requirement may serve the request. Capability on one provider must not make an
 * incompatible duplicate eligible, so a caller-provider match that does not
 * satisfy the requirement is skipped in favour of a qualified duplicate. A
 * disabled provider is never reintroduced to satisfy a requirement. The caller
 * model is only used as the resolution fallback when it itself satisfies the
 * requirement; otherwise resolution returns `undefined` with a diagnostic rather
 * than dispatching a child to an incompatible model.
 */
export function resolveExecutionModel(
	modelRegistry: ModelRegistryLike,
	callerModel: Model<any> | undefined,
	requestedModel: string | undefined,
	disabledProviders?: Set<string>,
	providerCapacity?: ProviderCapacitySnapshot,
	modelRequirements?: ModelRequirements,
): ResolvedExecutionModel {
	const isProviderEnabled = (provider: string): boolean => !disabledProviders?.has(provider);
	const requirementActive = requirementIsActive(modelRequirements);
	/** A model satisfies the active requirement (or the requirement is absent). */
	const satisfies = (model: Model<any> | undefined): boolean =>
		!requirementActive || (!!model && modelInputSatisfiesRequirement(model.input as ReadonlyArray<string> | undefined, modelRequirements));
	const callerProviderEnabled = !callerModel || isProviderEnabled(callerModel.provider);
	let resolvedModel: Model<any> | undefined = callerProviderEnabled && satisfies(callerModel) ? callerModel : undefined;
	let diagnostic: string | undefined;

	if (requestedModel) {
		const availableModels = modelRegistry.getAvailable();
		const allModels = modelRegistry.getAll();
		const requestedSpec = parseModelSpec(requestedModel);

		if (requestedSpec.provider) {
			const exact = modelRegistry.find(requestedSpec.provider, requestedSpec.id);
			if (exact && exact.provider === requestedSpec.provider && exact.id === requestedSpec.id
				&& isProviderEnabled(exact.provider) && satisfies(exact)) {
				return { resolvedModel: exact, actualModelId: exact.id };
			}
			if (exact && !isProviderEnabled(requestedSpec.provider)) {
				diagnostic = `Requested model "${requestedModel}" is available only from disabled provider "${requestedSpec.provider}". Falling back to caller/default model.`;
			} else if (requirementActive) {
				resolvedModel = undefined;
				diagnostic = `Requested model "${requestedModel}" has no enabled provider-qualified declaration satisfying modelRequirements.inputKinds=["${(modelRequirements?.inputKinds ?? []).join(",")}"].`;
			} else {
				diagnostic = `Requested model "${requestedModel}" not found in registry. Falling back to caller/default model.`;
			}
			return {
				resolvedModel,
				actualModelId: resolvedModel?.id,
				diagnostic,
			};
		}

		const availableMatches = availableModels.filter(
			(model) => model.id === requestedModel && isProviderEnabled(model.provider) && satisfies(model),
		);
		const hasImmediateCapacity = (provider: string): boolean =>
			providerCapacity?.[provider]?.immediatelyClaimable !== false;

		if (callerModel && isProviderEnabled(callerModel.provider)) {
			const sameProvider = modelRegistry.find(callerModel.provider, requestedModel);
			// A caller-provider match that does not satisfy the requirement is
			// skipped so capability on one provider never makes an incompatible
			// duplicate eligible. Only a qualified same-provider match is preferred.
			if (sameProvider && isProviderEnabled(sameProvider.provider) && satisfies(sameProvider)) {
				// Preserve the historical caller-provider preference unless that
				// provider is explicitly saturated and another enabled provider offering
				// the duplicate id is available or ungated (missing capacity state fails open).
				if (!hasImmediateCapacity(sameProvider.provider)) {
					const alternate = availableMatches.find((model) =>
						model.provider !== sameProvider.provider && hasImmediateCapacity(model.provider),
					);
					if (alternate) {
						return { resolvedModel: alternate, actualModelId: alternate.id };
					}
				}
				return { resolvedModel: sameProvider, actualModelId: sameProvider.id };
			}
		}

		// The caller may not offer this id (or its declaration does not satisfy
		// the requirement). Capacity-rank every enabled, requirement-qualified
		// duplicate before falling back to registry order, otherwise a saturated
		// first match can defeat bucket-level routing even though another provider
		// is free.
		const capacityAvailable = providerCapacity
			? availableMatches.find((model) => hasImmediateCapacity(model.provider))
			: undefined;
		const foundAvailable = capacityAvailable ?? availableMatches[0];
		if (foundAvailable) {
			return { resolvedModel: foundAvailable, actualModelId: foundAvailable.id };
		}

		const found = allModels.find((m) => m.id === requestedModel && isProviderEnabled(m.provider) && satisfies(m));
		if (found) {
			return { resolvedModel: found, actualModelId: found.id };
		}

		const disabledMatches = allModels
			.filter((m) => m.id === requestedModel && !isProviderEnabled(m.provider))
			.map((m) => m.provider);
		if (disabledMatches.length > 0) {
			diagnostic = `Requested model "${requestedModel}" is only available from disabled provider(s): ${[...new Set(disabledMatches)].join(", ")}. Falling back to caller/default model.`;
		} else if (requirementActive) {
			// The id exists in the registry but no enabled provider-qualified
			// declaration satisfies the requirement. Do not fall back to an
			// incompatible caller; surface the unmet requirement so the child is
			// not dispatched to a text-only model at this layer.
			resolvedModel = undefined;
			diagnostic = `Requested model "${requestedModel}" has no enabled provider-qualified declaration satisfying modelRequirements.inputKinds=["${(modelRequirements?.inputKinds ?? []).join(",")}"].`;
		} else {
			const allIds = allModels.map((m) => `${m.provider}/${m.id}`).slice(0, 10).join(", ");
			diagnostic = `Requested model "${requestedModel}" not found in registry. Available: ${allIds || "none"}. Falling back to caller/default model.`;
		}
	}

	return {
		resolvedModel,
		actualModelId: resolvedModel?.id,
		diagnostic,
	};
}
