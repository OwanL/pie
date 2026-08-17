export const SESSION_RUNTIME_ISOLATION_ENV = 'PIE_SESSION_RUNTIME_ISOLATION' as const;

export type RuntimeIsolationMode = 'legacy' | 'isolated';

/** Resolve once at coordinator construction. Unknown values fail closed so a
 * generation can never silently mix legacy and worker ownership semantics. */
export function resolveRuntimeIsolationMode(value = process.env[SESSION_RUNTIME_ISOLATION_ENV]): RuntimeIsolationMode {
  if (value === undefined || value === '1') return 'isolated';
  if (value === '0') return 'legacy';
  throw new Error(`${SESSION_RUNTIME_ISOLATION_ENV} must be unset, 0, or 1; received ${JSON.stringify(value)}.`);
}

const ISOLATED_PHASE3_METHODS: ReadonlySet<string> = new Set([
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
 * Phase 3 adds runtime-free create/duplicate/cold-truncate to the coordinator.
 * Every operation that executes, promotes, or consults an AgentSession remains
 * fail-closed until Phase 4. Global settings writes are cold; a session-scoped
 * settings write still requires a hot owner and is therefore unavailable.
 */
export function isPhase3IsolatedCoordinatorOperationAllowed(method: string, params: unknown): boolean {
  if (ISOLATED_PHASE3_METHODS.has(method)) return true;
  if (method === 'settings.set') {
    return !params || typeof params !== 'object' || !('sessionPath' in params) || !(params as { sessionPath?: unknown }).sessionPath;
  }
  return false;
}

/** Compatibility alias for tests/extensions compiled during the Phase 2 flag
 * rollout. Its behavior intentionally follows the completed Phase 3 catalog. */
export const isPhase2IsolatedCoordinatorOperationAllowed = isPhase3IsolatedCoordinatorOperationAllowed;
