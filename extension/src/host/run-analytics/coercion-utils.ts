import type { ComposerInput, RunOutcome } from '../../shared/protocol';

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isRunOutcome(value: unknown): value is RunOutcome {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const outcome = value as { resolution?: unknown; satisfaction?: unknown; source?: unknown };
  return (outcome.resolution === 'resolved'
      || outcome.resolution === 'partially_resolved'
      || outcome.resolution === 'unresolved')
    && typeof outcome.satisfaction === 'number'
    && Number.isFinite(outcome.satisfaction)
    && (outcome.source === undefined || outcome.source === 'user' || outcome.source === 'agent');
}

export function isInputKindArray(value: unknown): value is Array<ComposerInput['kind']> {
  return Array.isArray(value)
    && value.every((item) => item === 'filesystemPathRef' || item === 'imageBlob' || item === 'fileBlob');
}

export function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

/**
 * Coerce an optional non-negative integer that may be legitimately absent.
 * Returns `null` for missing/non-finite/negative values (treated as "not
 * measured"), otherwise `Math.trunc(value)`. Use for analytics fields that are
 * only present when their anchoring events were observed (e.g. turn-latency
 * breakdowns).
 */
export function toNullableNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

export function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
