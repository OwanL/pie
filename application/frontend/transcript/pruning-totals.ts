import type { PruningDetails } from '../../lib/protocol/index.js';

/** Numeric totals derived from a {@link PruningDetails} payload. */
export interface PruningTotals {
  skillsKept: number;
  skillsTotal: number;
  toolsKept: number;
  toolsTotal: number;
  tokensSaved: number;
}

/**
 * Compute the shared numeric totals for a pruning-result payload:
 * kept = included.length, total = included + excluded, tokens = skill + tool.
 *
 * String formatting diverges per UI surface, so this helper intentionally
 * returns only the numbers — every call site formats its own strings.
 */
export function pruningTotals(details: PruningDetails): PruningTotals {
  const skillsKept = details.includedSkills.length;
  const skillsTotal = skillsKept + details.excludedSkills.length;
  const toolsKept = details.includedTools.length;
  const toolsTotal = toolsKept + details.excludedTools.length;
  const tokensSaved = (details.skillTokensSaved ?? 0) + (details.toolTokensSaved ?? 0);
  return { skillsKept, skillsTotal, toolsKept, toolsTotal, tokensSaved };
}