/**
 * Model-selection primitives shared by execute.ts and modes.ts.
 *
 * These symbols previously lived in execute.ts. They were extracted into this
 * leaf module to break a circular import: execute.ts dynamically imported
 * modes.ts, while modes.ts statically imported these helpers back from
 * execute.ts. Under pi's on-the-fly TS→CJS transpilation that static
 * back-import could resolve to `undefined` when multiple AgentSessions loaded
 * the extension concurrently (parallel subagent dispatch), surfacing as
 * `Cannot read properties of undefined (reading 'checkTrailLoop')`.
 *
 * Both execute.ts and modes.ts now import from here; nothing in this file
 * imports either of them, so there is no cycle.
 */

import type { AgentConfig } from "../agents.js";
import type { ModelRequirements, SingleResult } from "../types.js";
import {
	type ThinkingLevel,
	type BucketAssignments,
	type SimpleModelConfig,
	type NestedAllowedBuckets,
	ALL_NESTED_BUCKETS_ALLOWED,
	downgradeBucketForNested,
} from "./bucket-config.js";
import { selectModel } from "../bucket-selector.js";
import { getCapacityAvailableModelIds } from "./provider-capacity.js";
import type { RuntimeModelRef } from "./runtime-provenance.js";

/** Runtime input kind a model may accept. Mirrors the pi-ai `Model.input` tuple
 *  element type; kept local so this leaf module does not import the SDK type
 *  (which would pull a cross-tree dependency into selection). */
export type ModelInputKind = "text" | "image";

/** True when `input` satisfies every requested kind in `requirement`. An absent
 *  or empty requirement is always satisfied (current selection behaviour). A
 *  missing/unknown `input` array never satisfies a non-empty requirement. */
export function modelInputSatisfiesRequirement(
	input: ReadonlyArray<string> | undefined,
	requirement: ModelRequirements | undefined,
): boolean {
	const kinds = requirement?.inputKinds;
	if (!kinds || kinds.length === 0) return true;
	if (!Array.isArray(input)) return false;
	for (const kind of kinds) {
		if (!input.includes(kind)) return false;
	}
	return true;
}

/** Whether a non-empty requirement is active (i.e. actually constrains
 *  selection). An absent object or empty `inputKinds` preserves current
 *  selection behaviour. */
export function requirementIsActive(requirement: ModelRequirements | undefined): boolean {
	return !!requirement?.inputKinds && requirement.inputKinds.length > 0;
}

/** Human-readable label for the active requirement kinds (e.g. `image`), used in
 *  diagnostics and rendering. Returns an empty string when no requirement is
 *  active. */
export function describeActiveRequirementKinds(requirement: ModelRequirements | undefined): string {
	const kinds = requirement?.inputKinds ?? [];
	return kinds.filter((k): k is "image" => k === "image").join(",");
}

/** Build the bounded local selection diagnostic when no enabled model satisfies
 *  the active requirement. Identifies the unmet requirement and gives recovery
 *  actions, per the design plan. */
export function formatRequirementDiagnostic(
	requirement: ModelRequirements | undefined,
	bucket: string,
): string {
	const kinds = describeActiveRequirementKinds(requirement);
	const kindLabel = kinds || "image";
	return `No enabled ${kindLabel}-capable model is available for the requested "${bucket}" subagent bucket. Add a ${kindLabel}-capable model to an eligible bucket, enable its provider, choose another bucket, or remove modelRequirements.inputKinds=["${kindLabel}"].`;
}

/** Context for model selection settings and restrictions. */
export interface SelectionContext {
	modelConfig: SimpleModelConfig[];
	disabledProviders: Set<string>;
	allowedModelIds: Set<string> | undefined;
	/** User-configured bucket assignments (read once from the env mirror). */
	bucketAssignments: BucketAssignments | undefined;
	/** Exact provider-qualified runtime reasoning support, when the registry
	 * exposes it through `reasoning` / `thinkingLevelMap`. */
	runtimeThinkingSupport?: import("../bucket-selector.js").RuntimeThinkingSupport;
	/** Reasoning level of the immediate caller, from `pi.getThinkingLevel()`.
	 * Empty buckets and always-parent routing inherit this rather than assuming
	 * a costly implicit default. */
	callerThinkingLevel?: ThinkingLevel;
	/** When true, skip bucket selection and always use the parent's active model. */
	alwaysParentModel: boolean;
	/** Opt-in soft routing around providers without an immediately claimable slot. */
	routeAroundSaturatedProviders?: boolean;
	/** Retry a replay-safe transient provider failure on another model in the same bucket. */
	fallbackOnProviderFailure?: boolean;
	/** Enabled/configured registry models used to map duplicate ids to providers
	 * and capture an optional runtime-declared family. */
	registryModels?: RuntimeModelRef[];
	/** Provider-qualified family declarations loaded from the generated catalog. */
	modelFamilies?: ReadonlyMap<string, string>;
	/** Per-tier allowlist restricting which buckets *nested* subagents (depth ≥ 1)
	 *  may use. Read once from the env mirror (PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON).
	 *  All-true (the default) leaves behaviour unchanged. */
	nestedAllowedBuckets: NestedAllowedBuckets;
	/** Per-call hard model requirements (e.g. image input). Undefined/empty
	 *  preserves current selection behaviour. */
	modelRequirements?: ModelRequirements;
	/** Runtime `input` kinds of the caller's active model, snapshotted in
	 *  `setupModelSelection` from `modelRegistry`/`ctx.model`. Used to check
	 *  whether the active-parent fallback satisfies {@link modelRequirements};
	 *  an incompatible parent produces a local selection error rather than a
	 *  silent text-only fallback. Only consulted when a requirement is active. */
	callerModelInput?: ReadonlyArray<ModelInputKind>;
	/** Hard requirement allowlist: model ids with at least one enabled
	 *  provider-qualified declaration whose runtime `input` satisfies
	 *  {@link modelRequirements}. Built once in `setupModelSelection` from
	 *  `modelRegistry.getAvailable()` (the runtime input-capability source —
	 *  `SimpleModelConfig` is NOT a capability source). Undefined when no
	 *  requirement is active (current selection behaviour). */
	requirementQualifiedModelIds?: Set<string>;
}

/** Resolved model selection result returned by {@link resolveModel}. The
 *  requirement-provenance fields are present only when an active requirement
 *  was made; an explicit return type (rather than an inferred union) keeps the
 *  optional fields accessible to consumers like `attachSelectionMetadata`. */
export interface ResolvedModel {
	modelOverride: string;
	thinkingLevel: ThinkingLevel | undefined;
	selection: {
		modelId: string;
		thinkingLevel?: ThinkingLevel;
		bucket: string;
		pool: string[];
		fallback: boolean;
	};
	bucket: string;
	bucketDowngradeReason?: string;
	requestedModelRequirements?: ModelRequirements;
	modelRequirementsSatisfied?: boolean;
	requirementDiagnostic?: string;
}

/** Resolves which model to use for an agent based on bucket hint and configuration.
 *
 *  `childDepth` is the depth of the subagent being spawned (parent depth + 1).
 *  When ≥ 1 (i.e. every subagent spawn — the root caller never reaches here),
 *  the nested-bucket allowlist is applied: a requested bucket not allowed for
 *  nested subagents is downgraded to the highest allowed tier at or below it
 *  (see `downgradeBucketForNested`). Omit `childDepth` to skip the cap (used by
 *  unit tests that exercise bucket selection directly without a runtime context).
 *
 *  When `selectionCtx.modelRequirements` is active, selection is a HARD
 *  requirement: only a provider-qualified model whose runtime `input`
 *  satisfies the requirement may serve the child. The normal bucket walk,
 *  nested-bucket cap, thinking-level, capacity, and exclusion rules still
 *  apply, but no text-only model may ever be chosen — including via the
 *  active-parent fallback, the "always use parent model" short-circuit, or the
 *  nested-bucket exhaustion fallback. When the requirement cannot be satisfied,
 *  a local selection error is returned (`requirementDiagnostic` + empty
 *  `modelOverride` + `modelRequirementsSatisfied: false`) so the caller fails
 *  before dispatching a child session rather than silently degrading. */
export async function resolveModel(
	agent: AgentConfig,
	selectionCtx: SelectionContext,
	activeModelId: string,
	perCallBucket?: string,
	excludeModels?: Set<string>,
	childDepth?: number,
): Promise<ResolvedModel> {
	const requestedBucket = perCallBucket ?? agent.bucket ?? "medium";
	// Only bucket assignments select reasoning. Parent-model fallback inherits
	// the immediate caller's current level; it deliberately has no implicit high.
	const thinkingLevel = selectionCtx.callerThinkingLevel;

	// Hard model requirement state. An absent/empty requirement preserves
	// current selection behaviour (no fields are stamped on results). When
	// active, the active-parent fallback is allowed only when the caller's own
	// model satisfies the requirement — checked via the caller's runtime input,
	// not the model-id set, so a duplicate id exposed by an incompatible
	// provider can never make an incompatible parent look eligible.
	const requirement = selectionCtx.modelRequirements;
	const requirementActive = requirementIsActive(requirement);
	const requirementQualifiedModelIds = requirementActive
		? selectionCtx.requirementQualifiedModelIds
		: undefined;
	const callerSatisfiesRequirement = modelInputSatisfiesRequirement(
		selectionCtx.callerModelInput,
		requirement,
	);
	// Provenance echoed on every return so running/terminal/retried/compacted
	// results carry the requested requirement and satisfaction flag. Omitted
	// (undefined) entirely when no requirement was made.
	const requirementProvenance = requirementActive
		? {
			requestedModelRequirements: requirement,
			modelRequirementsSatisfied: true as const,
		}
		: {};
	/** Local selection error: no enabled model satisfies the requirement. The
	 *  effective `bucket` argument is the bucket the requirement is reported
	 *  against (the requested tier, or the downgraded tier once the nested cap
	 *  has run). */
	const requirementError = (errorBucket: string): {
		modelOverride: string;
		thinkingLevel: ThinkingLevel | undefined;
		selection: { modelId: string; thinkingLevel: ThinkingLevel | undefined; bucket: string; pool: string[]; fallback: boolean };
		bucket: string;
		bucketDowngradeReason?: string;
		requestedModelRequirements?: ModelRequirements;
		modelRequirementsSatisfied?: boolean;
		requirementDiagnostic?: string;
	} => ({
		modelOverride: "",
		thinkingLevel,
		selection: {
			modelId: "",
			thinkingLevel,
			bucket: errorBucket,
			pool: [],
			fallback: true,
		},
		bucket: errorBucket,
		requestedModelRequirements: requirement,
		modelRequirementsSatisfied: false,
		requirementDiagnostic: formatRequirementDiagnostic(requirement, errorBucket),
	});

	// When the user has enabled "always use parent model", skip bucket
	// selection entirely and use the caller's active model (the same path as
	// the empty-pool fallback in selectModel). If the active model has been
	// excluded via retry, fall through to a "" modelId to signal exhaustion.
	// A hard requirement is NOT weakened here: an incompatible parent produces
	// a local selection error rather than a silent text-only dispatch.
	if (selectionCtx.alwaysParentModel) {
		if (requirementActive && !callerSatisfiesRequirement) {
			return { ...requirementError(requestedBucket), bucket: requestedBucket };
		}
		const fallbackId = activeModelId && !excludeModels?.has(activeModelId) ? activeModelId : "";
		return {
			modelOverride: fallbackId,
			thinkingLevel,
			selection: {
				modelId: fallbackId,
				thinkingLevel,
				bucket: requestedBucket,
				pool: [],
				fallback: true,
			},
			bucket: requestedBucket,
			...requirementProvenance,
		};
	}

	// Nested-bucket cap: for nested subagents (depth ≥ 1), restrict the bucket to
	// the user-configured allowlist. A requested tier that is not allowed is
	// downgraded to the highest allowed tier at or below it; when no tier is
	// allowed at all, fall back to the caller's active model (same path as the
	// empty-pool fallback in selectModel). The root caller never reaches here
	// (resolveModel is only invoked for subagent spawns), so this cap applies to
	// every subagent in the tree.
	let bucket = requestedBucket;
	let bucketDowngradeReason: string | undefined;
	if (childDepth !== undefined && childDepth >= 1) {
		const allowed = selectionCtx.nestedAllowedBuckets ?? ALL_NESTED_BUCKETS_ALLOWED;
		const downgraded = downgradeBucketForNested(bucket, allowed);
		if (downgraded.downgraded) {
			if (downgraded.bucket === "") {
				// No bucket is allowed for nested subagents: the only remaining
				// fallback is the caller's active model. A hard requirement is
				// still enforced — an incompatible parent is a local error.
				if (requirementActive && !callerSatisfiesRequirement) {
					return {
						...requirementError(bucket),
						bucketDowngradeReason: `Nested subagent (depth ${childDepth}) requested bucket "${bucket}" but no bucket is allowed for nested subagents; falling back to the parent's active model.`,
					};
				}
				const fallbackId = activeModelId && !excludeModels?.has(activeModelId) ? activeModelId : "";
				return {
					modelOverride: fallbackId,
					thinkingLevel,
					selection: {
						modelId: fallbackId,
						thinkingLevel,
						bucket,
						pool: [],
						fallback: true,
					},
					bucket,
					bucketDowngradeReason: `Nested subagent (depth ${childDepth}) requested bucket "${bucket}" but no bucket is allowed for nested subagents; falling back to the parent's active model.`,
					...requirementProvenance,
				};
			}
			bucketDowngradeReason = `Nested subagent (depth ${childDepth}) requested bucket "${requestedBucket}" but it is not allowed for nested subagents; downgraded to "${downgraded.bucket}".`;
			bucket = downgraded.bucket;
		}
	}

	// User-configured bucket assignments are read once from the env mirror
	// (PIE_SUBAGENT_BUCKETS_JSON) in setupModelSelection. When absent (e.g.
	// running under stock pi without the pie host), fall back to empty
	// assignments so selectModel falls through to the active model.
	const assignments = selectionCtx.bucketAssignments ?? { small: [], medium: [], frontier: [] };

	const capacityAvailableModelIds = selectionCtx.routeAroundSaturatedProviders
		? getCapacityAvailableModelIds(
			selectionCtx.registryModels ?? [],
			selectionCtx.disabledProviders,
		)
		: undefined;
	const selected = selectModel(
		bucket,
		assignments,
		selectionCtx.modelConfig,
		selectionCtx.allowedModelIds,
		excludeModels,
		activeModelId,
		thinkingLevel,
		capacityAvailableModelIds,
		requirementQualifiedModelIds,
		selectionCtx.runtimeThinkingSupport,
	);
	const selection = selected;

	// selectModel falls back to the caller's active model when every eligible
	// bucket at or below the request is empty. A hard requirement is enforced
	// here too: an incompatible active model is a local error, never a silent
	// text-only dispatch. (A qualified active model remains a valid fallback.)
	if (selection.fallback && requirementActive && !callerSatisfiesRequirement) {
		return { ...requirementError(bucket), bucketDowngradeReason };
	}

	return {
		modelOverride: selection.modelId,
		thinkingLevel: selection.thinkingLevel,
		selection,
		bucket,
		bucketDowngradeReason,
		...requirementProvenance,
	};
}

/** Attaches model selection metadata to a subagent result. */
export function attachSelectionMetadata(result: SingleResult, resolved: ResolvedModel): void {
	if (resolved.selection) {
		result.selectedModel = resolved.selection.modelId;
		result.selectionPool = resolved.selection.pool;
		result.thinkingLevel = resolved.selection.thinkingLevel;
		result.bucket = resolved.selection.bucket;
		result.fallback = resolved.selection.fallback;
	}
	if (resolved.bucketDowngradeReason) {
		result.bucketDowngradeReason = resolved.bucketDowngradeReason;
	}
	// Requirement provenance: requested requirements, satisfaction flag, and the
	// bounded diagnostic when selection failed. Stamped on progress, terminal,
	// retried, and force-settled results so the parent UI can surface the
	// requirement and any failure consistently. Omitted entirely when no
	// requirement was made.
	if (resolved.requestedModelRequirements) {
		result.requestedModelRequirements = resolved.requestedModelRequirements;
	}
	if (resolved.modelRequirementsSatisfied !== undefined && result.modelRequirementsSatisfied === undefined) {
		result.modelRequirementsSatisfied = resolved.modelRequirementsSatisfied;
	}
	if (resolved.requirementDiagnostic && !result.requirementDiagnostic) {
		result.requirementDiagnostic = resolved.requirementDiagnostic;
	}
}

/** Check if a subagent result represents a model-level failure that qualifies
 * for failover. A non-zero exit is not enough: auth/client failures are
 * terminal, and replay after partial output or any tool side effect can
 * duplicate externally-visible work. */
export function isModelFailure(
	result: SingleResult,
	modelOverride: string | undefined,
	hasBucketAssignments: boolean,
): boolean {
	return (
		result.exitCode !== 0 &&
		result.stopReason !== "aborted" &&
		modelOverride !== undefined &&
		hasBucketAssignments &&
		result.retryable === true &&
		result.replaySafety === "safe"
	);
}

export const checkTrailLoop = (agentName: string, trail: string[]): boolean => {
	const occurrences = trail.filter((t) => t === agentName).length;
	return occurrences >= 2;
};
