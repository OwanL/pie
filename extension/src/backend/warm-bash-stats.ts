import { EMPTY_WARM_BASH_STATS, type WarmBashStats } from '../shared/protocol/aggregate-stats';

/**
 * Read live warm-bash pool metrics from the warm-bash extension.
 *
 * The warm-bash extension runs in THIS backend child process (loaded by the pi
 * SDK) and registers per-session stats providers into a `Symbol.for`
 * globalThis registry (`extensions/warm-bash/src/stats.ts`). This module is the
 * read side for the backend's `warm_bash.stats` RPC handler — same process,
 * in-memory, no I/O. The two packages can't share code, so the registry
 * contract is the well-known `Symbol.for('pi.warmBashStatsRegistry')` key and
 * the `WarmBashStats` shape is duplicated (canonical type lives in
 * `shared/protocol/aggregate-stats.ts`, imported here).
 */

const REGISTRY_KEY = Symbol.for('pi.warmBashStatsRegistry');

interface Registry {
  providers: Map<string, () => WarmBashStats>;
}

/** Aggregate live warm-bash stats across all registered sessions. Returns
 *  {@link EMPTY_WARM_BASH_STATS} when no session has registered (e.g. warm
 *  bash disabled, or no bash call has happened yet to build a pool). */
export function collectWarmBashStats(): WarmBashStats {
  const reg = (globalThis as unknown as { [REGISTRY_KEY]?: Registry })[REGISTRY_KEY];
  if (!reg || reg.providers.size === 0) return EMPTY_WARM_BASH_STATS;
  let poolSize = 0;
  let ready = 0;
  let warming = 0;
  let totalFastPath = 0;
  let totalWarm = 0;
  let totalFallback = 0;
  let totalWarmupFailures = 0;
  let enabled = false;
  let fastPathEnabled = false;
  for (const provider of reg.providers.values()) {
    const s = provider();
    if (s.enabled) enabled = true;
    if (s.fastPathEnabled) fastPathEnabled = true;
    poolSize += s.poolSize;
    ready += s.ready;
    warming += s.warming;
    totalFastPath += s.totalFastPath;
    totalWarm += s.totalWarm;
    totalFallback += s.totalFallback;
    totalWarmupFailures += s.totalWarmupFailures;
  }
  return {
    enabled,
    poolSize,
    ready,
    warming,
    fastPathEnabled,
    totalFastPath,
    totalWarm,
    totalFallback,
    totalWarmupFailures,
  };
}