import type { RenderFailurePayload } from '../../shared/protocol';
import type { TranscriptCommitTarget } from './transcript/commit-registry';

let latestRenderTarget: Pick<TranscriptCommitTarget, 'revision' | 'viewGeneration'> | null = null;
let latestRenderSurface: RenderFailurePayload['surface'] = 'unknown';

/** Protocol-sync metadata only. Error values and transcript content never enter it. */
export function recordRenderEvidenceTarget(
  target: Pick<TranscriptCommitTarget, 'revision' | 'viewGeneration'> | null,
  surface: RenderFailurePayload['surface'],
): void {
  latestRenderTarget = target;
  latestRenderSurface = surface;
}

export function recordRenderSurface(surface: RenderFailurePayload['surface']): void {
  latestRenderSurface = surface;
}

/** Builds the complete typed failure payload without accepting arbitrary data. */
export function sanitizedRenderFailure(
  classification: RenderFailurePayload['classification'],
  surface: RenderFailurePayload['surface'] = latestRenderSurface,
): RenderFailurePayload {
  return {
    viewGeneration: latestRenderTarget?.viewGeneration ?? 0,
    revision: latestRenderTarget?.revision ?? null,
    surface,
    classification,
  };
}

/** Host-forwarded render diagnostics deliberately contain only a classification. */
export function sanitizedRenderLog(
  classification: RenderFailurePayload['classification'],
  scope: 'panel' | 'webview',
): { type: 'log'; level: 'error'; scope: 'panel' | 'webview'; message: RenderFailurePayload['classification'] } {
  return { type: 'log', level: 'error', scope, message: classification };
}

/**
 * Preact Suspense signals a pending lazy component through the global error
 * hook as a thrown thenable. It is control flow, not a render failure.
 */
export function isSuspenseThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}
