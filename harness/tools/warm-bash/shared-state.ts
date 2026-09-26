import type { WarmBashMetrics } from './operations.js';
import type { WarmBashPool } from './warm-pool.js';

export interface SharedPoolConfig {
  target: number;
  shell: string;
  warmup: number;
}

export interface SharedWarmBashState {
  pool: WarmBashPool | null;
  poolCfg: SharedPoolConfig | null;
  generation: number;
  metrics: Map<string, WarmBashMetrics>;
  processCleanupInstalled: boolean;
}

const SHARED_STATE_KEY = Symbol.for('pie.warmBashSharedState');

export function getSharedWarmBashState(): SharedWarmBashState {
  const global = globalThis as unknown as { [SHARED_STATE_KEY]?: SharedWarmBashState };
  if (!global[SHARED_STATE_KEY]) {
    global[SHARED_STATE_KEY] = {
      pool: null,
      poolCfg: null,
      generation: 0,
      metrics: new Map(),
      processCleanupInstalled: false,
    };
  }
  return global[SHARED_STATE_KEY]!;
}

/** Install process cleanup once across every main/nested AgentSession extension
 * instance. The handler resolves shared state at signal time, so pool rebuilds
 * do not leave it pointing at a disposed generation. */
export function installWarmBashProcessCleanup(): void {
  const shared = getSharedWarmBashState();
  if (shared.processCleanupInstalled) return;
  shared.processCleanupInstalled = true;
  for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => getSharedWarmBashState().pool?.dispose());
  }
}
