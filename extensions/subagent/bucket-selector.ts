/**
 * Bucket-based model selector (v2).
 *
 * The main agent provides a bucket hint ("small" / "medium" / "frontier") per
 * task and an optional thinkingLevel hint. The selector picks uniformly at
 * random from the *user-configured* bucket model lists (mirrored into the
 * process environment by the pie host as `PIE_SUBAGENT_BUCKETS_JSON`), filtered
 * by thinking support, provider allowlist, and exclusions.
 *
 * Bucket contents are user-configured in the pie settings UI (see
 * `subagentBuckets` in `ChatPrefs`) and persisted via `globalState` / mirrored
 * via the `runtimePrefs.set` RPC → `PIE_SUBAGENT_BUCKETS_JSON` env var.
 *
 * Config loading, bucket parsing, nested-bucket restrictions, and provider
 * toggles live in `src/bucket-config.ts` and `src/provider-toggles.ts`. This
 * module re-exports their public API and keeps the core selection logic
 * (`selectModel`, `nearestSupportedThinking`) intact.
 */

export * from "./src/bucket-config.js";
export * from "./src/provider-toggles.js";

import type {
  ThinkingLevel,
  BucketAssignments,
  SimpleModelConfig,
} from "./src/bucket-config.js";

export interface BucketSelection {
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  bucket: string;
  pool: string[];
  fallback: boolean;
}

/** Thinking levels ordered from lightest to heaviest. */
const THINKING_ORDER: ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// --- Thinking level helpers ---

/**
 * Find the nearest supported thinking level for a model.
 * If the requested level is unsupported, walks toward "medium" (the center)
 * and returns the closest supported level. If no levels are supported,
 * returns undefined.
 */
export function nearestSupportedThinking(
  requested: ThinkingLevel,
  supported: ThinkingLevel[],
): ThinkingLevel | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;

  const reqIndex = THINKING_ORDER.indexOf(requested);
  // Walk outward from the requested level
  for (let offset = 1; offset < THINKING_ORDER.length; offset++) {
    const lower = THINKING_ORDER[reqIndex - offset];
    const higher = THINKING_ORDER[reqIndex + offset];
    if (lower && supported.includes(lower)) return lower;
    if (higher && supported.includes(higher)) return higher;
  }
  return undefined;
}

// --- Selection ---

/**
 * Select a model from the user-configured bucket assignments.
 *
 * 1. Get bucket assignments (user-configured via the settings UI, mirrored
 *    through `PIE_SUBAGENT_BUCKETS_JSON`)
 * 2. Filter by thinkingLevel support (if provided)
 * 3. Filter by provider allowlist + excludeModels
 * 4. Soft-filter providers with no immediate capacity, but only when another
 *    candidate remains (all busy/unknown preserves the original pool)
 * 5. If no eligible model remains, walk down through cheaper buckets
 * 6. Pick uniformly at random from the highest eligible bucket
 * 7. Fall back to the active model only if every bucket at or below the request is empty
 *
 * @param bucket - Bucket hint: "small", "medium", or "frontier"
 * @param thinkingLevel - Optional thinking level hint
 * @param assignments - User-configured bucket assignments (from env)
 * @param modelConfig - Simple model config for thinking support lookup
 * @param allowedModelIds - Models allowed by provider toggles
 * @param excludeModels - Models to exclude (e.g., previously failed)
 * @param activeModelId - The caller's active model (fallback)
 * @param capacityAvailableModelIds - Soft live-capacity allowlist. Applied only
 *   when it leaves at least one otherwise-eligible bucket candidate.
 */
export function selectModel(
  bucket: string,
  thinkingLevel: ThinkingLevel | undefined,
  assignments: BucketAssignments,
  modelConfig: SimpleModelConfig[],
  allowedModelIds: Set<string> | undefined,
  excludeModels: Set<string> | undefined,
  activeModelId: string,
  capacityAvailableModelIds?: Set<string>,
): BucketSelection {
  // Build thinking support lookup from model config.
  const thinkingSupport = new Map<string, ThinkingLevel[]>();
  for (const cfg of modelConfig) {
    thinkingSupport.set(cfg.id, cfg.thinking);
  }

  const filterBucket = (bucketPool: string[]): { pool: string[]; thinkingLevel: ThinkingLevel | undefined } => {
    let pool = bucketPool;
    let effectiveThinkingLevel = thinkingLevel;

    // Thinking relaxation is bucket-local. A lower tier may support a different
    // nearest level than the originally requested (but unavailable) tier.
    if (thinkingLevel && pool.length > 0) {
      const thinkingFiltered = pool.filter((id) => {
        const supported = thinkingSupport.get(id);
        // Models not in config are treated as supporting all levels.
        return !supported || supported.includes(thinkingLevel);
      });

      if (thinkingFiltered.length > 0) {
        pool = thinkingFiltered;
      } else {
        const allSupported = new Set<ThinkingLevel>();
        for (const id of pool) {
          const supported = thinkingSupport.get(id);
          if (supported) for (const level of supported) allSupported.add(level);
        }
        const relaxed = nearestSupportedThinking(thinkingLevel, [...allSupported]);
        if (relaxed) {
          const relaxedPool = pool.filter((id) => {
            const supported = thinkingSupport.get(id);
            return !supported || supported.includes(relaxed);
          });
          if (relaxedPool.length > 0) {
            pool = relaxedPool;
            effectiveThinkingLevel = relaxed;
          }
        }
      }
    }

    if (allowedModelIds && pool.length > 0) {
      pool = pool.filter((id) => allowedModelIds.has(id));
    }
    if (excludeModels && pool.length > 0) {
      pool = pool.filter((id) => !excludeModels.has(id));
    }

    // Live capacity is a soft exclusion, distinct from disabled providers.
    // Preserve the eligible pool when every candidate is busy so one can queue.
    if (capacityAvailableModelIds && pool.length > 0) {
      const capacityFiltered = pool.filter((id) => capacityAvailableModelIds.has(id));
      if (capacityFiltered.length > 0) pool = capacityFiltered;
    }

    return { pool, thinkingLevel: effectiveThinkingLevel };
  };

  const tiersDescending = ["frontier", "medium", "small"] as const;
  const requestedTierIndex = tiersDescending.indexOf(bucket as (typeof tiersDescending)[number]);
  const candidateBuckets = requestedTierIndex >= 0
    ? tiersDescending.slice(requestedTierIndex)
    : [bucket];

  for (const candidateBucket of candidateBuckets) {
    const filtered = filterBucket(assignments[candidateBucket as keyof BucketAssignments] ?? []);
    if (filtered.pool.length === 0) continue;

    const pick = Math.floor(Math.random() * filtered.pool.length);
    return {
      modelId: filtered.pool[pick],
      thinkingLevel: filtered.thinkingLevel,
      bucket: candidateBucket,
      pool: filtered.pool,
      fallback: false,
    };
  }

  // Never route back to an active model that is unavailable under the current
  // provider toggles. An empty id signals model exhaustion to the runner.
  const activeModelAllowed = !allowedModelIds || allowedModelIds.has(activeModelId);
  const fallbackId = activeModelId && activeModelAllowed && !excludeModels?.has(activeModelId)
    ? activeModelId
    : "";
  return {
    modelId: fallbackId,
    thinkingLevel,
    bucket,
    pool: [],
    fallback: true,
  };
}
