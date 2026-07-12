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
import type { SingleResult } from "../types.js";
import {
	type ThinkingLevel,
	type BucketAssignments,
	type SimpleModelConfig,
	type NestedAllowedBuckets,
	ALL_NESTED_BUCKETS_ALLOWED,
	downgradeBucketForNested,
} from "./bucket-config.js";
import { selectModel } from "../bucket-selector.js";

/** Context for model selection settings and restrictions. */
export interface SelectionContext {
	modelConfig: SimpleModelConfig[];
	disabledProviders: Set<string>;
	allowedModelIds: Set<string> | undefined;
	/** User-configured bucket assignments (read once from the env mirror). */
	bucketAssignments: BucketAssignments | undefined;
	/** When true, skip bucket selection and always use the parent's active model. */
	alwaysParentModel: boolean;
	/** Per-tier allowlist restricting which buckets *nested* subagents (depth ≥ 1)
	 *  may use. Read once from the env mirror (PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON).
	 *  All-true (the default) leaves behaviour unchanged. */
	nestedAllowedBuckets: NestedAllowedBuckets;
}

/** Resolves which model to use for an agent based on bucket hint and configuration.
 *
 *  `childDepth` is the depth of the subagent being spawned (parent depth + 1).
 *  When ≥ 1 (i.e. every subagent spawn — the root caller never reaches here),
 *  the nested-bucket allowlist is applied: a requested bucket not allowed for
 *  nested subagents is downgraded to the highest allowed tier at or below it
 *  (see `downgradeBucketForNested`). Omit `childDepth` to skip the cap (used by
 *  unit tests that exercise bucket selection directly without a runtime context). */
export async function resolveModel(
	agent: AgentConfig,
	selectionCtx: SelectionContext,
	activeModelId: string,
	perCallBucket?: string,
	perCallThinkingLevel?: ThinkingLevel,
	excludeModels?: Set<string>,
	childDepth?: number,
) {
	const requestedBucket = perCallBucket ?? agent.bucket ?? "medium";
	const thinkingLevel = perCallThinkingLevel ?? agent.thinkingLevel;

	// When the user has enabled "always use parent model", skip bucket
	// selection entirely and use the caller's active model (the same path as
	// the empty-pool fallback in selectModel). If the active model has been
	// excluded via retry, fall through to a "" modelId to signal exhaustion.
	if (selectionCtx.alwaysParentModel) {
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

	const selection = selectModel(
		bucket,
		thinkingLevel,
		assignments,
		selectionCtx.modelConfig,
		selectionCtx.allowedModelIds,
		excludeModels,
		activeModelId,
	);

	return {
		modelOverride: selection.modelId,
		thinkingLevel: selection.thinkingLevel,
		selection,
		bucket,
		bucketDowngradeReason,
	};
}

/** Attaches model selection metadata to a subagent result. */
export function attachSelectionMetadata(result: SingleResult, resolved: Awaited<ReturnType<typeof resolveModel>>): void {
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
