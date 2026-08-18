/**
 * Coordinator-level operation catalog. The coordinator owns runtime-free
 * durable mutations and cold reads; every operation that executes, promotes,
 * or consults a hot session runtime is routed to the owning worker instead.
 */

const COORDINATOR_METHODS: ReadonlySet<string> = new Set([
  'app.ping',
  'diagnostics.livePipeline.setEnabled',
  'provider_gate.metrics',
  'runtimePrefs.set',
  'session.list',
  'session.create',
  'session.open',
  'session.viewed',
  'session.duplicate',
  'session.preload',
  'session.forget',
  'session.loadTranscriptPage',
  'session.loadDetail',
  'session.truncateAfter',
  'openTabs.set',
  'models.list',
  'settings.get',
]);

/**
 * True when the coordinator may handle `method` without a hot worker owner.
 * Global settings writes are cold; a session-scoped settings write still
 * requires a hot owner and is therefore unavailable here.
 */
export function isCoordinatorOperationAllowed(method: string, params: unknown): boolean {
  if (COORDINATOR_METHODS.has(method)) return true;
  if (method === 'settings.set') {
    return !params || typeof params !== 'object' || !('sessionPath' in params) || !(params as { sessionPath?: unknown }).sessionPath;
  }
  return false;
}
