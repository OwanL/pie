/** Cost evidence helpers shared by provider-response producers.
 *
 * Pi's `usage.cost.total` is populated by the SDK's model catalog calculator;
 * it is not, by itself, an invoice or provider-reported amount. Only an
 * explicit provider-report field is accepted as exact billing evidence.
 */

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Read an explicitly labelled provider-reported cost from an untyped payload.
 * Deliberately does not inspect `cost.total`: that field is the Pi SDK's
 * catalog estimate unless a producer has independently copied provider
 * evidence into one of the explicit fields below. */
export function providerReportedCostUsd(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const direct = finiteNonNegative(candidate.providerReportedCostUsd)
    ?? finiteNonNegative(candidate.reportedCostUsd);
  if (direct !== undefined) return direct;
  const cost = candidate.cost;
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) return undefined;
  const nested = cost as Record<string, unknown>;
  return finiteNonNegative(nested.providerReportedCostUsd)
    ?? finiteNonNegative(nested.reportedCostUsd);
}
