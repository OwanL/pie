import { createHash } from 'node:crypto';
import { assertAnalyticsBackendContext } from './backend-analytics-context.js';

/** Capture namespace, not activation evidence. Reopening an existing store must
 * retain its generationId so replay/idempotency keys keep their original scope.
 * Composition supplies this identity; helper startup never mints a replacement. */
export interface CanonicalAnalyticsRuntimeContext {
  readonly mode: 'canonical-only';
  readonly generationId: string;
  readonly buildId: string;
  readonly workspaceId: string;
  readonly hostInstanceId: string;
}

export class AnalyticsRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRuntimeError';
  }
}

export interface AnalyticsRuntimeAuthorityOptions {
  canonicalContext: CanonicalAnalyticsRuntimeContext;
  workspaceId: string;
  processGeneration: string;
  buildId: string;
}

/** Validates and freezes the canonical capture identity. No historical file is
 * consulted: lifecycle admission, not an activation receipt, authorizes writes. */
export class AnalyticsRuntimeAuthority {
  readonly canonicalContext: CanonicalAnalyticsRuntimeContext;

  constructor(options: AnalyticsRuntimeAuthorityOptions) {
    try {
      assertAnalyticsBackendContext(options.canonicalContext);
    } catch {
      throw new AnalyticsRuntimeError('Canonical analytics context is required and must be complete.');
    }
    const context = options.canonicalContext;
    if (context.buildId !== options.buildId
      || context.workspaceId !== options.workspaceId
      || context.hostInstanceId !== options.processGeneration) {
      throw new AnalyticsRuntimeError('Canonical analytics context does not match the runtime identity.');
    }
    this.canonicalContext = Object.freeze({ ...context });
  }
}

/** Stable workspace identity shared by canonical capture and backend context. */
export function analyticsWorkspaceId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
