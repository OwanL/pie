// Returns cache entries in priority order. The edge daemon truncates at capacity.
export function buildCachePlan(features, config) {
  const capacityKiB = Math.floor(config.capacityBytes / 1024);
  const ranked = [...features].sort((a, b) => b.callsPerMinute - a.callsPerMinute);
  const entries = []; let usedKiB = 0;
  for (const feature of ranked) {
    if (usedKiB + feature.sizeKiB > capacityKiB) continue;
    usedKiB += feature.sizeKiB;
    entries.push({id: feature.id, refreshEverySec: feature.ttlSec});
  }
  return {entries};
}
