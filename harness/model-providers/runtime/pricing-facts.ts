import { createHash } from 'node:crypto';
import { parseModelPricing } from '../pricing/pricing-core';
import type { CapturedPricingFacts, ModelPricingRecord } from '../../../analytics/contracts/model-pricing-facts';
import type { RuntimeSnapshot } from './contracts';
import { immutable, validNativeModel } from './projection';
import { rejectedLegacyOverridePricing } from './recovery';

/** Existing analytics pricing contract, with rates from this capture only. No catalog I/O,
 * rate defaults, accounting capture, or analytics-authority selection occurs here. */
export function buildProviderRuntimePricingFacts(snapshot: RuntimeSnapshot,
  recoverRejectedLegacyOverrides = false): CapturedPricingFacts {
  const records = new Map<string, ModelPricingRecord[]>();
  const recovered: ModelPricingRecord[] = [];
  for (const row of snapshot.models) {
    const overridePricing = recoverRejectedLegacyOverrides ? rejectedLegacyOverridePricing(row) : undefined;
    const cost = row.model && !row.rejection && validNativeModel(row.model) ? row.model.cost : undefined;
    if (!cost && !overridePricing) continue;
    const record = immutable({ id: row.id, provider: row.providerId,
      pricing: overridePricing ?? parseModelPricing(row.pricingFacts) ?? { input: cost!.input, output: cost!.output, cacheRead: cost!.cacheRead, cacheWrite: cost!.cacheWrite } });
    if (overridePricing) recovered.push(record);
    for (const key of new Set([row.id, `${row.providerId}/${row.id}`])) {
      const list = records.get(key) ?? [];
      list.push(record);
      records.set(key, list);
    }
  }
  for (const list of records.values()) Object.freeze(list);
  // A readonly facade (not merely Object.freeze(Map), whose set() remains mutable).
  const map: ReadonlyMap<string, ModelPricingRecord[]> = Object.freeze({
    get size() { return records.size; },
    get: (key: string) => records.get(key),
    has: (key: string) => records.has(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    values: () => records.values(),
    [Symbol.iterator]: () => records[Symbol.iterator](),
    forEach: (callback: (value: ModelPricingRecord[], key: string, map: ReadonlyMap<string, ModelPricingRecord[]>) => void, thisArg?: unknown) => {
      records.forEach((value, key) => callback.call(thisArg, value, key, map));
    },
  });
  // Discovery or compiled SDK prices can change without a YAML revision. The
  // pricing identity must name the immutable capture, not just that YAML file.
  const catalogVersion = `sha256:${createHash('sha256').update(JSON.stringify(recovered.length ? { snapshot, recovered } : snapshot)).digest('hex')}`;
  return Object.freeze({ catalogVersion, map });
}
