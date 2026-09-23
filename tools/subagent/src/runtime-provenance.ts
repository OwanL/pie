import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { SingleResult } from "../types.js";
import type { ModelProviderRef } from "./provider-toggles.js";

export interface RuntimeModelRef extends ModelProviderRef {
	family?: unknown;
}

export interface RuntimeProvenanceSeed {
	promptHash: string;
	requestedBucket: string;
	parentToolCallId: string;
	modelFamilies?: ReadonlyMap<string, string>;
	registryModels?: RuntimeModelRef[];
}

/** SHA-256 of the exact `task` string supplied to the subagent tool. No
 * trimming, prompt formatting, or parent-context concatenation is applied. */
export function hashDelegatedPrompt(task: string): string {
	return createHash("sha256").update(task, "utf8").digest("hex");
}

function familyKey(provider: string, modelId: string): string {
	return `${provider}\u0000${modelId}`;
}

/** Load declared provider/model families from the generated model catalog.
 * Malformed or absent catalogs degrade to an empty map; callers then use the
 * documented model-id fallback in {@link deriveEffectiveFamily}. */
export function loadModelFamilies(catalogPath: string): Map<string, string> {
	const families = new Map<string, string>();
	if (!existsSync(catalogPath)) return families;
	try {
		const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as { providers?: Record<string, unknown> };
		for (const [provider, rawProvider] of Object.entries(parsed.providers ?? {})) {
			if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
			const providerRecord = rawProvider as Record<string, unknown>;
			const add = (modelId: string, rawModel: unknown): void => {
				if (!modelId) return;
				const model = rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)
					? rawModel as Record<string, unknown>
					: undefined;
				const declared = typeof model?.family === "string" ? model.family.trim() : "";
				families.set(familyKey(provider, modelId), declared || modelId);
			};
			if (Array.isArray(providerRecord.models)) {
				for (const rawModel of providerRecord.models) {
					if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
					const modelId = (rawModel as Record<string, unknown>).id;
					if (typeof modelId === "string") add(modelId, rawModel);
				}
			}
			if (providerRecord.modelOverrides && typeof providerRecord.modelOverrides === "object" && !Array.isArray(providerRecord.modelOverrides)) {
				for (const [modelId, rawModel] of Object.entries(providerRecord.modelOverrides as Record<string, unknown>)) {
					add(modelId, rawModel);
				}
			}
		}
	} catch {
		return new Map();
	}
	return families;
}

/** Resolve a provider-agnostic effective family from the runtime-effective
 * provider/model pair. Resolution order is deterministic: provider-qualified
 * generated catalog entry, provider-qualified runtime registry declaration,
 * then the effective model id itself. If no effective model is observable,
 * the explicit final fallback is `unknown`. */
export function deriveEffectiveFamily(
	provider: string | undefined,
	modelId: string | undefined,
	modelFamilies?: ReadonlyMap<string, string>,
	registryModels?: RuntimeModelRef[],
): string {
	const normalizedModel = modelId?.trim();
	if (!normalizedModel) return "unknown";
	if (provider) {
		const catalogFamily = modelFamilies?.get(familyKey(provider, normalizedModel))?.trim();
		if (catalogFamily) return catalogFamily;
		const registryMatch = registryModels?.find((model) => model.provider === provider && model.id === normalizedModel);
		const runtimeFamily = typeof registryMatch?.family === "string" ? registryMatch.family.trim() : "";
		if (runtimeFamily) return runtimeFamily;
	}
	return normalizedModel;
}

/** Return a result copy with immutable call provenance plus fields derived from
 * the latest runtime-effective model/provider and effective bucket. */
export function withRuntimeProvenance(result: SingleResult, seed: RuntimeProvenanceSeed): SingleResult {
	return {
		...result,
		promptHash: seed.promptHash,
		requestedBucket: seed.requestedBucket,
		bucketDowngraded: Boolean(result.bucketDowngradeReason)
			|| (typeof result.bucket === "string" && result.bucket !== seed.requestedBucket),
		parentToolCallId: seed.parentToolCallId,
		family: deriveEffectiveFamily(result.provider, result.model, seed.modelFamilies, seed.registryModels),
	};
}
