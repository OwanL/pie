/**
 * Live warm-bash pool metrics, reported per session to the host status strip.
 *
 * The warm-bash extension runs in the pi backend child process; the backend
 * request-handler (`extension/src/backend`) runs in the SAME process but is a
 * separate package and cannot import this module. We bridge the two via a
 * `Symbol.for` globalThis registry: the extension registers a stats getter per
 * session, the backend's `warm_bash.stats` RPC handler aggregates them. Both
 * sides reference the same `Symbol.for('pi.warmBashStatsRegistry')` key.
 *
 * The `WarmBashStats` shape is duplicated in `extension/src/shared/protocol/
 * aggregate-stats.ts` (the canonical type the host/webview consume); keep the
 * two in sync when adding fields.
 */
export interface WarmBashStats {
  /** Warm bash is active for at least one session (pool size > 0, not disposed). */
  enabled: boolean;
  /** Configured warm pool size (sum across active sessions). */
  poolSize: number;
  /** Idle warm workers ready to serve a command immediately. */
  ready: number;
  /** Workers currently warming (spawned but not yet ready). */
  warming: number;
  /** Fast-path toggle is on for at least one session. */
  fastPathEnabled: boolean;
  /** Commands run via the execFile fast path (no shell at all). */
  totalFastPath: number;
  /** Commands run via the warm pool (pre-warmed shell + marker protocol). */
  totalWarm: number;
  /** Commands run via the fresh-spawn fallback (today's exact path). */
  totalFallback: number;
  /** Warmup attempts that failed (timed out / shell unavailable). */
  totalWarmupFailures: number;
}

export const EMPTY_WARM_BASH_STATS: WarmBashStats = {
  enabled: false,
  poolSize: 0,
  ready: 0,
  warming: 0,
  fastPathEnabled: false,
  totalFastPath: 0,
  totalWarm: 0,
  totalFallback: 0,
  totalWarmupFailures: 0,
};

export type WarmBashStatsProvider = () => WarmBashStats;

const REGISTRY_KEY = Symbol.for('pi.warmBashStatsRegistry');

interface Registry {
  providers: Map<string, WarmBashStatsProvider>;
}

function getRegistry(): Registry {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { providers: new Map() };
  return g[REGISTRY_KEY]!;
}

/** Register a per-session stats provider. Returns an unregister function. */
export function registerWarmBashStats(sessionId: string, provider: WarmBashStatsProvider): () => void {
  const reg = getRegistry();
  reg.providers.set(sessionId, provider);
  return () => {
    reg.providers.delete(sessionId);
  };
}

/** Aggregate live stats across all registered sessions. Called by the backend
 *  `warm_bash.stats` RPC handler (same process, in-memory, no I/O). */
export function collectWarmBashStats(): WarmBashStats {
  const reg = getRegistry();
  if (reg.providers.size === 0) return EMPTY_WARM_BASH_STATS;
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