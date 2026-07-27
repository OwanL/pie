/**
 * Browser-safe leaderboard diagnostic weights.
 *
 * V2 qualityIndexV1 is the only ranking input. Runtime dimensions remain visible
 * for diagnosis and therefore have zero composite weight.
 */
export const LEADERBOARD_WEIGHTS = {
  fileChurn: 0,
  toolReliability: 0,
  verificationPassRate: 0,
  tokenEfficiency: 0,
} as const;
