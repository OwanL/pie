/**
 * Coordinator-level operation catalog. The coordinator owns runtime-free
 * durable mutations and cold reads; every operation that executes, promotes,
 * or consults a hot session runtime is routed to the owning worker instead.
 */

const COORDINATOR_METHODS: ReadonlySet<string> = new Set([
  'app.ping',
  'diagnostics.livePipeline.setEnabled',
  'mcp.list',
  'mcp.setServerEnabled',
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
 * A session-scoped `settings.set` is allowed here: for a cold session there is
 * no live runtime to mutate, so the coordinator persists the model/thinking
 * level directly (and re-broadcasts to hot workers) instead of paying a full
 * worker promotion. A hot session is still routed to its owning worker first.
 */
export function isCoordinatorOperationAllowed(method: string, _params: unknown): boolean {
  if (COORDINATOR_METHODS.has(method)) return true;
  if (method === 'settings.set') return true;
  return false;
}
