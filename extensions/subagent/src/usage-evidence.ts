import { providerReportedCostUsd as readProviderReportedCostUsd } from '../../../shared/provider-cost.js';

/**
 * Cost-evidence helpers for subagent usage projection.
 *
 * Pi's `usage.cost.total` is calculated from SDK model metadata. It is kept
 * out of provider billing evidence; only a separately labelled provider or
 * invoice value may populate the exact-cost path.
 */

/** Extract explicitly labelled provider-reported cost evidence. */
export function reportedUsageCost(usage: unknown): number | undefined {
	return readProviderReportedCostUsd(usage);
}

/** Evidence-preserving cost sum: defined only when at least one operand
 * carries provider-cost evidence. */
export function sumReportedCost(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}
