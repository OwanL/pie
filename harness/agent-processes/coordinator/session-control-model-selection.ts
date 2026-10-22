import {
  getRuntimeThinkingSupport,
  parseBucketConfig,
  selectModel,
  type BucketAssignments,
  type BucketTier,
  type ThinkingLevel,
} from "../../tools/subagent/bucket-selector.js";

import type { SubagentBucketChoices } from "../../../lib/subagent-bucket-policy.js";

export { parseBucketConfig };

/** Runtime declarations deliberately require no Pi SDK types. */
export interface SessionControlModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  /** Catalogs carry the exact runtime support as a JSON-safe list. */
  thinkingLevels?: readonly ThinkingLevel[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface SessionControlModelSelectionInput {
  bucket: BucketTier;
  assignments: BucketAssignments;
  callerModel: { provider: string; id: string };
  callerThinkingLevel?: ThinkingLevel;
  subagentProviderChoices: Readonly<Record<string, boolean>>;
  subagentBucketChoices?: Readonly<SubagentBucketChoices>;
  providerToggles: Readonly<Record<string, boolean>>;
  availableModels: readonly SessionControlModel[];
  isEligible?: (model: SessionControlModel) => boolean;
}

export interface SessionControlModelSelection {
  model: { provider: string; id: string };
  reasoning?: ThinkingLevel;
  requestedBucket: BucketTier;
  effectiveBucket: BucketTier;
  pool: string[];
  /** True only for caller inheritance, not a descending tier selection. */
  fallback: boolean;
}

/** Select explicit bucket reasoning, descending through cheaper tiers before
 * inheriting the caller. Missing provider toggle entries remain enabled. */
export function selectSessionControlModel(input: SessionControlModelSelectionInput): SessionControlModelSelection {
  const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
  const models = input.availableModels.filter((model) =>
    input.providerToggles[model.provider] !== false
    && input.subagentProviderChoices[model.provider] !== false
    && (input.isEligible?.(model) ?? true));
  const byKey = new Map(models.map((model) => [key(model), model]));
  const support = new Map(models.map((model) => [key(model),
    model.thinkingLevels ? new Set(model.thinkingLevels) : getRuntimeThinkingSupport(model)]));
  const assignments = parseBucketConfig(JSON.stringify(input.assignments));
  for (const tier of ["small", "medium", "frontier"] as const) {
    assignments[tier] = assignments[tier].flatMap((assignment) => {
      // Qualified identities never resolve to a different provider. Legacy
      // bare ids prefer the caller provider, otherwise must be unambiguous.
      const exact = byKey.get(assignment.model);
      const bare = assignment.model.includes("/") ? [] : models.filter((model) => model.id === assignment.model);
      const resolved = exact ?? bare.find((model) => model.provider === input.callerModel.provider)
        ?? (bare.length === 1 ? bare[0] : undefined);
      return resolved ? [{ ...assignment, model: key(resolved) }] : [];
    });
  }
  const callerKey = key(input.callerModel);
  const callerAllowed = byKey.has(callerKey)
    && (input.callerThinkingLevel === undefined || support.get(callerKey)!.has(input.callerThinkingLevel));
  const selection = selectModel(
    input.bucket, assignments, [], new Set(byKey.keys()), undefined,
    callerAllowed ? callerKey : "", input.callerThinkingLevel,
    undefined, undefined, support, input.subagentBucketChoices,
  );
  const model = byKey.get(selection.modelId);
  if (!model) {
    const caller = callerKey.slice(0, 160);
    throw new Error(`No eligible session-control model for bucket ${input.bucket}; caller ${caller} allowed=${callerAllowed}; ${models.length} enabled eligible runtime models. Check provider toggles, bucket assignments and thinking support.`);
  }
  return {
    model: { provider: model.provider, id: model.id },
    reasoning: selection.thinkingLevel,
    requestedBucket: input.bucket,
    effectiveBucket: selection.bucket as BucketTier,
    pool: selection.pool,
    fallback: selection.fallback,
  };
}
