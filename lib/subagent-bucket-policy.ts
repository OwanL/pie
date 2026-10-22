export const SUBAGENT_BUCKET_TIERS = ['small', 'medium', 'frontier'] as const;

export type SubagentBucketTier = (typeof SUBAGENT_BUCKET_TIERS)[number];
export type SubagentBucketChoices = Record<SubagentBucketTier, boolean>;

export const DEFAULT_SUBAGENT_BUCKET_CHOICES: Readonly<SubagentBucketChoices> = {
  small: true,
  medium: true,
  frontier: true,
};

/** Return true only for a complete, non-empty selection with no extra keys. */
export function isSubagentBucketChoices(value: unknown): value is SubagentBucketChoices {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const keys = Reflect.ownKeys(value);
  if (keys.length !== SUBAGENT_BUCKET_TIERS.length) return false;

  const choices = value as Record<PropertyKey, unknown>;
  let enabled = false;
  for (const tier of SUBAGENT_BUCKET_TIERS) {
    if (!Object.hasOwn(choices, tier) || typeof choices[tier] !== 'boolean') return false;
    enabled ||= choices[tier] as boolean;
  }
  return enabled;
}

/** Normalize persisted settings only; malformed and legacy values use the permissive default. */
export function normalizeSubagentBucketChoices(value: unknown): SubagentBucketChoices {
  if (!isSubagentBucketChoices(value)) return { ...DEFAULT_SUBAGENT_BUCKET_CHOICES };
  return { small: value.small, medium: value.medium, frontier: value.frontier };
}

/** Resolve to the requested tier, then the nearest lower eligible tier, then nearest higher. */
export function resolveEnabledSubagentBucket(
  requested: SubagentBucketTier,
  choices: Readonly<SubagentBucketChoices>,
  allowedBuckets?: ReadonlySet<SubagentBucketTier>,
): SubagentBucketTier | undefined {
  const requestedIndex = SUBAGENT_BUCKET_TIERS.indexOf(requested);
  const eligible = (tier: SubagentBucketTier): boolean => choices[tier] && (allowedBuckets === undefined || allowedBuckets.has(tier));

  if (eligible(requested)) return requested;
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const tier = SUBAGENT_BUCKET_TIERS[index]!;
    if (eligible(tier)) return tier;
  }
  for (let index = requestedIndex + 1; index < SUBAGENT_BUCKET_TIERS.length; index += 1) {
    const tier = SUBAGENT_BUCKET_TIERS[index]!;
    if (eligible(tier)) return tier;
  }
  return undefined;
}
