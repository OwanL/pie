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
 * 4. Pick uniformly at random from remaining entries
 * 5. Fall back to active model if bucket is empty
 *
 * @param bucket - Bucket hint: "small", "medium", or "frontier"
 * @param thinkingLevel - Optional thinking level hint
 * @param assignments - User-configured bucket assignments (from env)
 * @param modelConfig - Simple model config for thinking support lookup
 * @param allowedModelIds - Models allowed by provider toggles
 * @param excludeModels - Models to exclude (e.g., previously failed)
 * @param activeModelId - The caller's active model (fallback)
 */
export function selectModel(
  bucket: string,
  thinkingLevel: ThinkingLevel | undefined,
  assignments: BucketAssignments,
  modelConfig: SimpleModelConfig[],
  allowedModelIds: Set<string> | undefined,
  excludeModels: Set<string> | undefined,
  activeModelId: string,
): BucketSelection {
  const bucketKey = bucket as keyof BucketAssignments;
  let pool = assignments[bucketKey] ?? [];

  // Build thinking support lookup from model config
  const thinkingSupport = new Map<string, ThinkingLevel[]>();
  for (const cfg of modelConfig) {
    thinkingSupport.set(cfg.id, cfg.thinking);
  }

  // Filter by thinkingLevel if provided
  if (thinkingLevel && pool.length > 0) {
    const requestedLevel = thinkingLevel;
    const thinkingFiltered = pool.filter((id) => {
      const supported = thinkingSupport.get(id);
      // Models not in config are treated as supporting all levels
      if (!supported) return true;
      return supported.includes(requestedLevel);
    });

    if (thinkingFiltered.length === 0) {
      // Relax to nearest supported thinking level
      const allSupported = new Set<ThinkingLevel>();
      for (const id of pool) {
        const supported = thinkingSupport.get(id);
        if (supported) for (const l of supported) allSupported.add(l);
      }
      const relaxed = nearestSupportedThinking(requestedLevel, [...allSupported]);
      if (relaxed) {
        thinkingLevel = relaxed;
        // Re-filter with relaxed level
        const relaxedPool = pool.filter((id) => {
          const supported = thinkingSupport.get(id);
          if (!supported) return true;
          return supported.includes(relaxed);
        });
        if (relaxedPool.length > 0) {
          pool = relaxedPool;
        }
      }
    } else {
      pool = thinkingFiltered;
    }
  }

  // Filter by provider allowlist
  if (allowedModelIds && pool.length > 0) {
    pool = pool.filter((id) => allowedModelIds.has(id));
  }

  // Filter by excludeModels
  if (excludeModels && pool.length > 0) {
    pool = pool.filter((id) => !excludeModels.has(id));
  }

  // If pool is empty, fall back to active model
  if (pool.length === 0) {
    // If the active model itself has been excluded, return empty to signal exhaustion.
    const fallbackId = activeModelId && !excludeModels?.has(activeModelId) ? activeModelId : "";
    return {
      modelId: fallbackId,
      thinkingLevel,
      bucket,
      pool: [],
      fallback: true,
    };
  }

  // Pick uniformly at random
  const pick = Math.floor(Math.random() * pool.length);

  return {
    modelId: pool[pick],
    thinkingLevel,
    bucket,
    pool,
    fallback: false,
  };
}
