/**
 * Bucket-based model selector.
 *
 * Buckets contain explicit model/reasoning assignments. The caller selects a
 * bucket only; an assignment's thinking level is never overridden, relaxed, or
 * clamped during selection.
 */

export * from "./src/bucket-config.js";
export * from "./src/provider-toggles.js";

import type {
  ThinkingLevel,
  BucketAssignment,
  BucketAssignments,
  SimpleModelConfig,
} from "./src/bucket-config.js";
import { parseModelSpec } from "./src/bucket-config.js";

export interface BucketSelection {
  modelId: string;
  /** Explicit assignment level, or the immediate caller's level on fallback. */
  thinkingLevel?: ThinkingLevel;
  bucket: string;
  pool: string[];
  fallback: boolean;
}

/** Exact runtime support, keyed by canonical `provider/id`. An absent key
 * means the runtime did not expose enough information, so the profile fallback
 * (or permissive legacy bare-spec path) decides eligibility. */
export type RuntimeThinkingSupport = ReadonlyMap<string, ReadonlySet<ThinkingLevel>>;

const fairSelectionBags = new Map<string, BucketAssignment[]>();

/** Reset the fair-selection shuffle bags. Tests use this to guarantee a
 * deterministic first draw across independent test cases; production code
 * should not call this. */
export function resetFairSelectionBags(): void {
  fairSelectionBags.clear();
}

function selectFairly(pool: BucketAssignment[]): BucketAssignment {
  // A model occurs only once per bucket by config validation, but include its
  // assigned level in this identity so direct/manual callers remain correct.
  const uniquePool = [...new Map(pool.map((entry) => [`${entry.model}\u0000${entry.thinkingLevel}`, entry])).values()];
  const key = uniquePool
    .map((entry) => `${entry.model}\u0000${entry.thinkingLevel}`)
    .sort()
    .join("\u0001");
  let bag = fairSelectionBags.get(key);
  if (!bag || bag.length === 0) {
    bag = [...uniquePool];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    fairSelectionBags.set(key, bag);
  }
  return bag.pop()!;
}

function isAssignmentSupported(
  assignment: BucketAssignment,
  modelConfig: SimpleModelConfig[],
  runtimeThinkingSupport: RuntimeThinkingSupport | undefined,
): boolean {
  const exactRuntime = runtimeThinkingSupport?.get(assignment.model);
  if (exactRuntime) return exactRuntime.has(assignment.thinkingLevel);

  const parsed = parseModelSpec(assignment.model);
  if (!parsed.provider && runtimeThinkingSupport) {
    const matchingRuntime = [...runtimeThinkingSupport.entries()]
      .filter(([spec]) => parseModelSpec(spec).id === parsed.id)
      .map(([, support]) => support);
    if (matchingRuntime.length > 0) {
      // Execution resolution may choose any enabled declaration for a bare id
      // (including the caller's provider), so fail closed unless every possible
      // provider supports the assigned level.
      return matchingRuntime.every((support) => support.has(assignment.thinkingLevel));
    }
  }

  // Prefer an exact provider-qualified profile. A manually supplied bare spec
  // is eligible only when every possible matching declaration supports its
  // explicit level; it is never treated as universally supported merely
  // because generated profiles now carry providers.
  const profiles = modelConfig.filter((candidate) => candidate.id === parsed.id);
  if (parsed.provider) {
    const exactProfile = profiles.find((candidate) => candidate.provider === parsed.provider)
      ?? profiles.find((candidate) => !candidate.provider);
    return !exactProfile || exactProfile.thinking.includes(assignment.thinkingLevel);
  }
  return profiles.length === 0
    || profiles.every((profile) => profile.thinking.includes(assignment.thinkingLevel));
}

/**
 * Select a model from the user-configured bucket assignments.
 *
 * Provider/capacity/requirements/exclusion filtering and the descending bucket
 * walk retain their prior behavior. Explicit assignments with an unsupported
 * level are excluded; they are never silently relaxed to another level.
 */
export function selectModel(
  bucket: string,
  assignments: BucketAssignments,
  modelConfig: SimpleModelConfig[],
  allowedModelIds: Set<string> | undefined,
  excludeModels: Set<string> | undefined,
  activeModelId: string,
  callerThinkingLevel: ThinkingLevel | undefined,
  capacityAvailableModelIds?: Set<string>,
  requirementQualifiedModelIds?: Set<string>,
  runtimeThinkingSupport?: RuntimeThinkingSupport,
): BucketSelection {
  const filterBucket = (bucketPool: BucketAssignment[]): BucketAssignment[] => {
    let pool = bucketPool.filter((assignment) => isAssignmentSupported(assignment, modelConfig, runtimeThinkingSupport));
    if (allowedModelIds) pool = pool.filter((assignment) => allowedModelIds.has(assignment.model));
    if (excludeModels) pool = pool.filter((assignment) => !excludeModels.has(assignment.model));
    if (requirementQualifiedModelIds) pool = pool.filter((assignment) => requirementQualifiedModelIds.has(assignment.model));
    if (capacityAvailableModelIds && pool.length > 0) {
      const capacityFiltered = pool.filter((assignment) => capacityAvailableModelIds.has(assignment.model));
      if (capacityFiltered.length > 0) pool = capacityFiltered;
    }
    return pool;
  };

  const tiersDescending = ["frontier", "medium", "small"] as const;
  const requestedTierIndex = tiersDescending.indexOf(bucket as (typeof tiersDescending)[number]);
  const candidateBuckets = requestedTierIndex >= 0 ? tiersDescending.slice(requestedTierIndex) : [bucket];

  for (const candidateBucket of candidateBuckets) {
    const filtered = filterBucket(assignments[candidateBucket as keyof BucketAssignments] ?? []);
    if (filtered.length === 0) continue;
    const selected = selectFairly(filtered);
    return {
      modelId: selected.model,
      thinkingLevel: selected.thinkingLevel,
      bucket: candidateBucket,
      pool: filtered.map((assignment) => assignment.model),
      fallback: false,
    };
  }

  const activeModelAllowed = !allowedModelIds || allowedModelIds.has(activeModelId);
  const fallbackId = activeModelId && activeModelAllowed && !excludeModels?.has(activeModelId) ? activeModelId : "";
  return {
    modelId: fallbackId,
    thinkingLevel: callerThinkingLevel,
    bucket,
    pool: [],
    fallback: true,
  };
}
