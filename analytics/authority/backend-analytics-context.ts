import type { CanonicalAnalyticsRuntimeContext } from './analytics-runtime.js';

/** Capture namespace only: never activation/qualification evidence. */
export type AnalyticsBackendContext = CanonicalAnalyticsRuntimeContext;

const KEYS = ['mode', 'generationId', 'buildId', 'workspaceId', 'hostInstanceId'].sort();

export function assertAnalyticsBackendContext(value: unknown): asserts value is AnalyticsBackendContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid analytics backend context.');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])
    || fields.mode !== 'canonical-only'
    || KEYS.some((key) => typeof fields[key] !== 'string' || (fields[key] as string).trim().length === 0)) {
    throw new Error('Invalid or partial analytics backend context.');
  }
}

export function sameAnalyticsBackendContext(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    assertAnalyticsBackendContext(left);
    assertAnalyticsBackendContext(right);
    return KEYS.every((key) => left[key as keyof AnalyticsBackendContext] === right[key as keyof AnalyticsBackendContext]);
  } catch {
    return false;
  }
}
